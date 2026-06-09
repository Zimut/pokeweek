// PokeWeek online server: a single zero-dependency Node process that BOTH
// serves the static client AND hosts authoritative WebSocket battles.
//
//   node server/server.mjs        (or: npm run server)
//
// The same engine that runs in the browser for AI/hotseat play runs here as
// the source of truth for online PvP: clients only send their chosen action
// each turn; the server resolves the turn and streams back the event log.
//
// The WebSocket layer is a minimal hand-rolled RFC 6455 implementation (text
// frames only, server frames unmasked, client frames unmasked on read) so the
// project keeps its "no npm dependencies" rule.
import http from 'node:http';
import crypto from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Battle } from '../src/engine/battle.js';
import { Dex } from '../src/engine/dex.js';
import { LobbyRegistry, ensureWorld } from './world.js';
import { flushAll } from './persist.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = normalize(join(__dirname, '..'));
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Resilience: a single bad client message, malformed WebSocket frame, or stray
// async rejection must never take the whole server down. Log it and keep
// running so the lobby/preview stays up.
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException (kept alive):', (err && err.stack) || err);
});
process.on('unhandledRejection', (err) => {
  console.error('[server] unhandledRejection (kept alive):', (err && err.stack) || err);
});

// ---------------------------------------------------------------------------
//  Data
// ---------------------------------------------------------------------------
let DEX = null;
export async function ensureDex() {
  if (DEX) return DEX;
  const files = ['pokedex', 'moves', 'typechart', 'learnsets'];
  const [pokedex, moves, typechart, learnsets] = await Promise.all(
    files.map((f) => readFile(join(ROOT, 'src', 'data', `${f}.json`), 'utf8').then(JSON.parse)),
  );
  DEX = new Dex({ pokedex, moves, typechart, learnsets });
  return DEX;
}

// The lobby registry (created once; boot-loads saved lobbies from disk).
let REGISTRY = null;
export async function ensureRegistry() {
  if (REGISTRY) return REGISTRY;
  const dex = await ensureDex();
  const world = await ensureWorld();
  REGISTRY = new LobbyRegistry(world, dex);
  // When a week-mode lobby locks (final day), launch its arena tournament.
  REGISTRY.onWeekEnd = (lobby) => { try { beginArenaTournament(lobby); } catch { /* best-effort */ } };
  const restored = await REGISTRY.loadFromDisk();
  if (restored) console.log(`Restored ${restored} saved lobb${restored === 1 ? 'y' : 'ies'} from disk.`);
  return REGISTRY;
}

// ---------------------------------------------------------------------------
//  Static file serving (mirrors scripts/serve.mjs)
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.gif': 'image/gif',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

async function serveStatic(req, res) {
  try {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = normalize(join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT + sep) && filePath !== ROOT) { res.writeHead(403); res.end('Forbidden'); return; }
    const info = await stat(filePath).catch(() => null);
    if (!info || info.isDirectory()) { res.writeHead(404); res.end('Not found'); return; }
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch (err) { res.writeHead(500); res.end('Server error: ' + err.message); }
}

// ---------------------------------------------------------------------------
//  Minimal RFC 6455 WebSocket connection
// ---------------------------------------------------------------------------
export class WSConn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.fragOpcode = null;
    this.alive = true;
    this.onMessage = null;
    this.onClose = null;
    this._room = null;
    this._name = 'Player';
    this._team = [];
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._handleClose());
    socket.on('error', () => this._handleClose());
  }

  _onData(d) {
    try {
      this.buf = Buffer.concat([this.buf, d]);
      this._parse();
    } catch (err) {
      console.error('[server] socket parse error (dropping connection):', (err && err.message) || err);
      try { this.close(); } catch { /* ignore */ }
    }
  }

  _parse() {
    while (true) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) { if (this.buf.length < offset + 2) return; len = this.buf.readUInt16BE(offset); offset += 2; }
      else if (len === 127) {
        if (this.buf.length < offset + 8) return;
        const hi = this.buf.readUInt32BE(offset), lo = this.buf.readUInt32BE(offset + 4);
        len = hi * 2 ** 32 + lo; offset += 8;
      }
      let mask = null;
      if (masked) { if (this.buf.length < offset + 4) return; mask = this.buf.slice(offset, offset + 4); offset += 4; }
      if (this.buf.length < offset + len) return;
      let payload = this.buf.slice(offset, offset + len);
      if (masked) { const out = Buffer.allocUnsafe(len); for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3]; payload = out; }
      this.buf = this.buf.slice(offset + len);
      this._handleFrame(fin, opcode, payload);
    }
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode === 0x8) { this.close(); return; }      // close
    if (opcode === 0x9) { this._sendFrame(0xa, payload); return; } // ping -> pong
    if (opcode === 0xa) return;                          // pong
    if (opcode === 0x0) this.frags.push(payload);        // continuation
    else { this.frags = [payload]; this.fragOpcode = opcode; }
    if (!fin) return;
    const full = Buffer.concat(this.frags);
    this.frags = [];
    if (this.fragOpcode !== 0x1) return;                 // only handle text
    let msg;
    try { msg = JSON.parse(full.toString('utf8')); } catch { return; }
    if (this.onMessage) {
      try { this.onMessage(msg); }
      catch (err) { console.error('[server] message handler error:', (err && err.stack) || err); }
    }
  }

  _sendFrame(opcode, payload) {
    if (!this.alive) return;
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
    else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[1] = 127; header.writeUInt32BE(Math.floor(len / 2 ** 32), 2); header.writeUInt32BE(len >>> 0, 6); }
    header[0] = 0x80 | opcode;
    try { this.socket.write(Buffer.concat([header, payload])); } catch { /* socket gone */ }
  }

  send(obj) { this._sendFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8')); }

  close() {
    if (!this.alive) return;
    try { this._sendFrame(0x8, Buffer.alloc(0)); } catch { /* ignore */ }
    try { this.socket.end(); } catch { /* ignore */ }
    this._handleClose();
  }

  _handleClose() {
    if (!this.alive) return;
    this.alive = false;
    if (this.onClose) this.onClose();
  }
}

// ---------------------------------------------------------------------------
//  Matchmaking + authoritative battle rooms
// ---------------------------------------------------------------------------
const queue = [];

export function handleConnection(conn) {
  conn.onMessage = (m) => {
    if (!m || typeof m !== 'object') return;
    // ---- battle-lab matchmaking (existing) -------------------------------
    if (m.t === 'queue') {
      conn._name = (typeof m.name === 'string' && m.name.trim()) ? m.name.trim().slice(0, 20) : 'Player';
      conn._team = Array.isArray(m.team) ? m.team : [];
      enqueue(conn);
    } else if (m.t === 'choice') {
      if (conn._room) conn._room.onChoice(conn, m.choice);
    } else if (m.t === 'leave') {
      conn.close();
    // ---- lobby / persistence (Task 16) -----------------------------------
    } else {
      handleLobbyMessage(conn, m);
    }
  };
  conn.onClose = () => {
    removeFromQueue(conn);
    if (conn._room) conn._room.onLeave(conn);
    if (REGISTRY) REGISTRY.detachPresence(conn);
  };
  conn.send({ t: 'hello' });
}

// Lobby protocol: create / join / resume a persistent world, and stream save
// snapshots back to the server. The server owns identity + durability; the
// client simulates and reports its save.
export function handleLobbyMessage(conn, m) {
  if (!REGISTRY) { conn.send({ t: 'error', msg: 'Lobby service not ready.' }); return; }
  const pickOpts = () => ({ mode: m.mode, dayLength: m.dayLength, dayLengthMs: m.dayLengthMs, ballAllowance: m.ballAllowance, name: m.name, starter: m.starter, character: m.character });

  switch (m.t) {
    case 'createLobby': {
      const { lobby, identity } = REGISTRY.createLobby(pickOpts());
      conn._lobbyCode = lobby.code;
      conn._playerId = identity.playerId;
      REGISTRY.registerConn(conn);
      conn.send({ t: 'lobbyCreated', code: lobby.code, playerId: identity.playerId, secret: identity.secret, config: lobby.publicConfig(), save: identity.save });
      return;
    }
    case 'joinLobby': {
      const code = String(m.code || '').trim();
      const res = REGISTRY.joinLobby(code, pickOpts());
      if (!res) { conn.send({ t: 'error', code: 'NO_LOBBY', msg: 'No lobby found with that code.' }); return; }
      conn._lobbyCode = res.lobby.code;
      conn._playerId = res.identity.playerId;
      REGISTRY.registerConn(conn);
      conn.send({ t: 'joined', code: res.lobby.code, playerId: res.identity.playerId, secret: res.identity.secret, config: res.lobby.publicConfig(), save: res.identity.save });
      return;
    }
    case 'auth': {
      const res = REGISTRY.auth(String(m.code || '').trim(), m.playerId, m.secret);
      if (!res) { conn.send({ t: 'error', code: 'AUTH_FAILED', msg: 'Could not resume this game.' }); return; }
      conn._lobbyCode = res.lobby.code;
      conn._playerId = m.playerId;
      REGISTRY.registerConn(conn);
      conn.send({ t: 'resumed', code: res.lobby.code, playerId: m.playerId, config: res.lobby.publicConfig(), save: res.player.save });
      return;
    }
    case 'saveState': {
      if (!conn._lobbyCode || !conn._playerId) { conn.send({ t: 'error', code: 'NOT_AUTHED', msg: 'Not in a lobby.' }); return; }
      REGISTRY.saveState(conn._lobbyCode, conn._playerId, m.save);
      if (m.ack) conn.send({ t: 'saved', at: Date.now() });
      return;
    }
    // ---- presence + click-to-invite PvP (Task 17) ------------------------
    case 'presence': {
      if (!conn._lobbyCode || !conn._playerId) return;
      REGISTRY.updatePresence(conn, { map: m.map, x: m.x, y: m.y, facing: m.facing });
      return;
    }
    // ---- ephemeral overworld chat ----------------------------------------
    // Fan a short message out to everyone on the sender's current map; clients
    // show it as a speech bubble that fades on its own (no stored chat log).
    case 'chat': {
      if (!conn._lobbyCode || !conn._playerId || !conn._pres) return;
      const text = typeof m.text === 'string' ? m.text.trim().slice(0, 120) : '';
      if (!text) return;
      REGISTRY.broadcastToMap(conn._lobbyCode, conn._pres.map, conn._playerId, { t: 'chat', id: conn._playerId, text });
      return;
    }
    // ---- player card (name / money / team, no moves) ---------------------
    case 'playerCard': {
      if (!conn._lobbyCode) return;
      const lobby = REGISTRY.get(conn._lobbyCode);
      const p = lobby && lobby.players[m.playerId];
      if (!p || !p.save) { conn.send({ t: 'error', code: 'NO_PLAYER', msg: 'That player is not available.' }); return; }
      const save = p.save;
      const team = (save.party || []).map((mon) => ({
        species: mon.species, level: mon.level, ivs: mon.ivs, evs: mon.evs, shiny: !!mon.shiny,
      }));
      conn.send({ t: 'playerCard', id: m.playerId, name: save.name || 'Player', money: save.money || 0, character: save.character || 'red', team });
      return;
    }
    case 'invitePvp': {
      handlePvpInvite(conn, m);
      return;
    }
    case 'acceptPvp': {
      handlePvpAccept(conn, m);
      return;
    }
    case 'declinePvp': {
      const inviter = REGISTRY.connFor(conn._lobbyCode, m.fromPlayerId);
      if (inviter && inviter._pvpInvite && inviter._pvpInvite.to === conn._playerId) inviter._pvpInvite = null;
      if (inviter) { try { inviter.send({ t: 'pvpDeclined', byPlayerId: conn._playerId }); } catch { /* ignore */ } }
      return;
    }
    case 'cancelPvp': {
      conn._pvpInvite = null;
      return;
    }
    case 'pvpLeave': {
      if (conn._room) conn._room.onLeave(conn);
      return;
    }
    // ---- tournament arena (Task 19) --------------------------------------
    case 'tournamentEnter': {
      // A player arrived in the arena. Make sure a (gathering) tournament
      // exists and send them the current bracket state.
      const lobby = REGISTRY.get(conn._lobbyCode);
      if (!lobby) return;
      const t = ensureTournament(lobby);
      t.broadcastState();
      return;
    }
    case 'tournamentReady': {
      const t = tournamentFor(conn._lobbyCode);
      if (t && conn._playerId) t.markReady(conn._playerId);
      return;
    }
    case 'tournamentStart': {
      const t = tournamentFor(conn._lobbyCode);
      const lobby = REGISTRY.get(conn._lobbyCode);
      if (t && lobby && lobby.hostId === conn._playerId) {
        if (!t.start(true)) conn.send({ t: 'error', code: 'NOT_ENOUGH', msg: 'Need at least two players in the arena to start.' });
      }
      return;
    }
    case 'tournamentSync': {
      const t = tournamentFor(conn._lobbyCode);
      if (t) { try { conn.send({ t: 'tournamentState', tournament: t.snapshot() }); } catch { /* ignore */ } }
      return;
    }
    case 'leaveLobby': {
      REGISTRY.detachPresence(conn);
      conn._pvpInvite = null;
      conn._lobbyCode = null;
      conn._playerId = null;
      conn.send({ t: 'leftLobby' });
      return;
    }
    default:
      return;
  }
}

// A player taps another character to challenge them. The target must be online
// and standing on the same map; the invite is remembered (with a TTL) so only a
// genuine, fresh acceptance starts a battle.
const INVITE_TTL_MS = 60000;
function handlePvpInvite(conn, m) {
  if (!conn._lobbyCode || !conn._playerId) return;
  const inviteLobby = REGISTRY.get(conn._lobbyCode);
  if (inviteLobby && inviteLobby.locked) { conn.send({ t: 'error', code: 'WEEK_OVER', msg: 'The week is over — battles are closed.' }); return; }
  if (conn._room) { conn.send({ t: 'error', code: 'BUSY', msg: 'You are already in a battle.' }); return; }
  const target = REGISTRY.connFor(conn._lobbyCode, m.toPlayerId);
  if (!target || target._playerId === conn._playerId) { conn.send({ t: 'error', code: 'NO_PLAYER', msg: 'That player is not online.' }); return; }
  if (target._room) { conn.send({ t: 'error', code: 'TARGET_BUSY', msg: 'That player is already battling.' }); return; }
  if (!conn._pres || !target._pres || conn._pres.map !== target._pres.map) {
    conn.send({ t: 'error', code: 'OFF_MAP', msg: "That player isn't on your route." });
    return;
  }
  conn._pvpInvite = { to: target._playerId, at: Date.now() };
  const lobby = REGISTRY.get(conn._lobbyCode);
  const p = lobby && lobby.players[conn._playerId];
  const fromName = (p && p.save && p.save.name) || 'A challenger';
  try { target.send({ t: 'pvpInvite', fromPlayerId: conn._playerId, fromName }); } catch { /* ignore */ }
}

function handlePvpAccept(conn, m) {
  if (!conn._lobbyCode || !conn._playerId) return;
  const lobby = REGISTRY.get(conn._lobbyCode);
  if (!lobby) return;
  const inviter = REGISTRY.connFor(conn._lobbyCode, m.fromPlayerId);
  if (!inviter || !inviter._pvpInvite || inviter._pvpInvite.to !== conn._playerId) {
    conn.send({ t: 'error', code: 'NO_INVITE', msg: 'That challenge is no longer available.' });
    return;
  }
  if (Date.now() - inviter._pvpInvite.at > INVITE_TTL_MS) { inviter._pvpInvite = null; conn.send({ t: 'error', code: 'EXPIRED', msg: 'That challenge expired.' }); return; }
  if (inviter._room || conn._room) { conn.send({ t: 'error', code: 'BUSY', msg: 'Someone is already in a battle.' }); return; }
  inviter._pvpInvite = null;

  const idA = inviter._playerId, idB = conn._playerId;
  const pa = lobby.players[idA], pb = lobby.players[idB];
  if (!pa || !pb) { conn.send({ t: 'error', code: 'NO_PLAYER', msg: 'A player left the lobby.' }); return; }
  // Both fight at the shared map's level cap (same map by invite rule).
  const cap = lobby.mapCap((inviter._pres && inviter._pres.map) || (conn._pres && conn._pres.map) || 1);
  inviter._name = (pa.save.name || 'Player'); inviter._team = teamFromSave(pa.save, cap);
  conn._name = (pb.save.name || 'Player'); conn._team = teamFromSave(pb.save, cap);
  if (!validTeam(inviter._team) || !validTeam(conn._team)) {
    conn.send({ t: 'error', code: 'BAD_TEAM', msg: 'A team is empty or invalid.' });
    return;
  }
  try {
    new GameRoom(inviter, conn, DEX, {
      onEnd: (winnerSide) => {
        const out = lobby.applyPvpResult(idA, idB, winnerSide);
        REGISTRY.persist(lobby.code);
        const sp = (team) => (team || []).map((t) => t.species);
        // The winner earns EV candies for the opposing team they defeated.
        if (out[idA]) { try { inviter.send({ t: 'pvpResult', ...out[idA], defeatedTeam: out[idA].result === 'win' ? sp(conn._team) : null }); } catch { /* ignore */ } }
        if (out[idB]) { try { conn.send({ t: 'pvpResult', ...out[idB], defeatedTeam: out[idB].result === 'win' ? sp(inviter._team) : null }); } catch { /* ignore */ } }
      },
    });
  } catch (err) {
    try { inviter.send({ t: 'error', msg: 'Could not start battle.' }); } catch { /* ignore */ }
    try { conn.send({ t: 'error', msg: 'Could not start battle.' }); } catch { /* ignore */ }
  }
}

// Build engine "sets" from a saved party, clamped to a map's level cap.
function teamFromSave(save, cap) {
  return (Array.isArray(save.party) ? save.party : []).map((p) => ({
    species: p.species,
    level: Math.min(p.level || 5, cap),
    moves: Array.isArray(p.moves) ? p.moves.slice() : [],
    shiny: !!p.shiny,
  }));
}

function removeFromQueue(conn) {
  const i = queue.indexOf(conn);
  if (i >= 0) queue.splice(i, 1);
}

function enqueue(conn) {
  if (conn._room || queue.includes(conn)) return;
  if (!validTeam(conn._team)) { conn.send({ t: 'error', msg: 'Invalid team.' }); return; }
  conn.send({ t: 'queued' });
  queue.push(conn);
  tryMatch();
}

function validTeam(team) {
  if (!Array.isArray(team) || team.length < 1 || team.length > 6) return false;
  return team.every((s) => s && typeof s.species === 'string');
}

function tryMatch() {
  while (queue.length >= 2) {
    const a = queue.shift();
    const b = queue.shift();
    if (!a.alive) { if (b.alive) queue.unshift(b); continue; }
    if (!b.alive) { if (a.alive) queue.unshift(a); continue; }
    try {
      new GameRoom(a, b, DEX);
    } catch (err) {
      // A bad team can throw while building the Battle; drop both cleanly.
      try { a.send({ t: 'error', msg: 'Could not start battle.' }); } catch { /* ignore */ }
      try { b.send({ t: 'error', msg: 'Could not start battle.' }); } catch { /* ignore */ }
    }
  }
}

export class GameRoom {
  // opts.onEnd(winnerSide) — optional; lets a lobby PvP battle apply rewards
  // (winner +₽1000 / loser −₽1000) when the fight resolves. winnerSide is the
  // absolute side index (0 = a, 1 = b) or 'tie'.
  // opts.spectators() — optional; returns the live conns who should receive a
  // read-only copy of the event feed (tournament arena, Task 19).
  // opts.matchInfo — optional metadata (e.g. { tournament:true }) echoed on the
  // `matched` message so the client knows to auto-return to the arena after.
  constructor(a, b, dex, opts = {}) {
    this.players = [
      { conn: a, queue: [], waiter: null },
      { conn: b, queue: [], waiter: null },
    ];
    this.onEnd = typeof opts.onEnd === 'function' ? opts.onEnd : null;
    this.spectators = typeof opts.spectators === 'function' ? opts.spectators : null;
    this.matchInfo = opts.matchInfo || null;
    this._ended = false;
    a._room = this; b._room = this;
    this.over = false;
    this.battle = new Battle({
      dex, seed: (Math.random() * 2 ** 31) | 0, kind: 'pvp',
      sides: [{ team: a._team, name: a._name }, { team: b._team, name: b._name }],
    });
    const names = [a._name, b._name];
    const tournament = !!this.matchInfo;
    a.send({ t: 'matched', side: 0, names, tournament });
    b.send({ t: 'matched', side: 1, names, tournament });
    this.run().catch((err) => { if (process.env.PW_DEBUG) console.error('[room error]', err && err.stack || err); this.fail(); });
  }

  // Fan a read-only frame out to the current spectators (no-op without any).
  _specSend(msg) {
    if (!this.spectators) return;
    for (const conn of this.spectators()) { try { conn.send(msg); } catch { /* socket gone */ } }
  }

  onChoice(conn, choice) {
    const i = this.players[0].conn === conn ? 0 : 1;
    const p = this.players[i];
    if (p.waiter) { const w = p.waiter; p.waiter = null; w(choice); }
    else p.queue.push(choice);
  }

  awaitChoice(i) {
    const p = this.players[i];
    if (p.queue.length) return Promise.resolve(p.queue.shift());
    return new Promise((res) => { p.waiter = res; });
  }

  broadcast(msg) { for (const p of this.players) p.conn.send(msg); }

  broadcastEvents(events) {
    const teams = [this.battle.teamView(this.battle.sides[0]), this.battle.teamView(this.battle.sides[1])];
    this.broadcast({ t: 'events', events, teams });
    // Spectators get the same feed in ABSOLUTE side order (0 = a, 1 = b) plus
    // the player names so a neutral renderer can label both corners.
    this._specSend({ t: 'spectate', sub: 'events', events, teams, names: [this.players[0].conn._name, this.players[1].conn._name] });
  }

  async run() {
    const b = this.battle;
    b.start();
    this.broadcastEvents(b.flushLog());
    while (b.state !== 'end' && !this.over) {
      const need = [b.needAction(0), b.needAction(1)];
      const waits = [];
      for (let i = 0; i < 2; i++) {
        if (need[i]) {
          this.players[i].conn.send({ t: 'request', request: b.getRequest(i) });
          waits.push(this.awaitChoice(i).then((c) => ({ i, c })));
        } else {
          this.players[i].conn.send({ t: 'waitOpp' });
        }
      }
      const results = await Promise.all(waits);
      if (this.over) return;
      for (const { i, c } of results) b.choose(i, sanitizeChoice(c));
      b.go();
      this.broadcastEvents(b.flushLog());
    }
    if (this.over) return;
    this.over = true;
    this.broadcast({ t: 'end', winner: b.winner, turns: b.turn });
    this._finish(b.winner);
    this.cleanup();
  }

  onLeave(conn) {
    if (this.over) return;
    this.over = true;
    const leftSide = this.players[0].conn === conn ? 0 : 1;
    const other = this.players[1 - leftSide].conn;
    try { other.send({ t: 'oppLeft' }); } catch { /* ignore */ }
    // A walkout hands the win (and its reward) to the player who stayed.
    this._finish(1 - leftSide);
    this._unblock();
    this.cleanup();
  }

  // Fire the optional reward callback exactly once, whatever ends the battle.
  // Spectators are told the result here too so every end path (normal, walkout,
  // error) closes their read-only view consistently.
  _finish(winnerSide) {
    if (this._ended) return;
    this._ended = true;
    this._specSend({ t: 'spectate', sub: 'end', winner: winnerSide, names: [this.players[0].conn._name, this.players[1].conn._name] });
    if (this.onEnd) { try { this.onEnd(winnerSide); } catch { /* ignore */ } }
  }

  fail() {
    if (this.over) return;
    this.over = true;
    for (const p of this.players) { try { p.conn.send({ t: 'error', msg: 'Battle error.' }); } catch { /* ignore */ } }
    this._unblock();
    this.cleanup();
  }

  _unblock() {
    for (const p of this.players) if (p.waiter) { const w = p.waiter; p.waiter = null; w({ type: 'move', move: 0 }); }
  }

  cleanup() { for (const p of this.players) p.conn._room = null; }
}

// Defensive shaping so a malformed client message can't crash the engine.
export function sanitizeChoice(c) {
  if (!c || typeof c !== 'object') return { type: 'move', move: 0 };
  if (c.type === 'switch') return { type: 'switch', target: (c.target | 0) };
  if (c.forced) return { type: 'move', forced: String(c.forced) };
  return { type: 'move', move: (c.move | 0) };
}

// ---------------------------------------------------------------------------
//  Tournament (Task 19) — single-elimination bracket on the arena map (8)
// ---------------------------------------------------------------------------
// One match is live at a time: the two bracketed players fight a normal
// server-authoritative GameRoom while every other player present in the arena
// spectates the same event feed (a read-only stream). Winners advance until a
// champion remains. This lives in server.mjs (not world.js) so it can build
// GameRooms directly without a circular import. Tournaments are runtime-only
// (a server restart drops an in-progress bracket; final money is already saved).
const TOURNEY_MATCH_DELAY_MS = 3000; // breather between matches (> client auto-exit)
const TOURNAMENTS = new Map();       // lobby code -> Tournament

export function tournamentFor(code) { return TOURNAMENTS.get(String(code)) || null; }
export function clearTournament(code) { return TOURNAMENTS.delete(String(code)); }

export class Tournament {
  constructor(lobby, dex, registry, opts = {}) {
    this.lobby = lobby;
    this.dex = dex;
    this.reg = registry;
    this.status = 'gathering';   // gathering -> active -> done
    this.ready = new Set();      // playerIds who tapped "ready"
    this.entrants = [];          // playerIds in seeded (shuffled) order
    this.rounds = [];            // [[{ id, a, b, bye, winner }]]
    this.champion = null;        // playerId of the winner
    this.current = null;         // the live match object (or null)
    this.room = null;            // the live GameRoom (or null)
    this._seq = 0;
    this.matchDelayMs = opts.matchDelayMs ?? TOURNEY_MATCH_DELAY_MS;
  }

  get code() { return this.lobby.code; }
  arenaMap() { return this.lobby.world.progression.arenaMap; }
  nameOf(id) { const p = this.lobby.players[id]; return (p && p.save && p.save.name) || 'Player'; }
  connOf(id) { return this.reg.connFor(this.code, id); }

  // Player ids whose live connection is currently standing in the arena.
  presentIds() {
    const arena = this.arenaMap();
    const m = this.reg.live.get(this.code);
    if (!m) return [];
    const out = [];
    for (const conn of m.values()) if (conn._pres && conn._pres.map === arena) out.push(conn._playerId);
    return out;
  }

  // A player tapped "ready" during gathering. Auto-start once everyone present
  // is ready (and there are at least two of them).
  markReady(id) {
    if (this.status !== 'gathering') return;
    this.ready.add(id);
    const present = this.presentIds();
    if (present.length >= 2 && present.every((p) => this.ready.has(p))) this.start(false);
    else this.broadcastState();
  }

  // Begin the bracket. force=true (host) skips the all-ready gate. Seeds a
  // random single-elimination round over everyone present in the arena.
  start(force) {
    if (this.status !== 'gathering') return false;
    let ids = this.presentIds();
    if (ids.length < 2) return false;
    if (!force && !ids.every((p) => this.ready.has(p))) return false;
    ids = ids.slice();
    for (let i = ids.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [ids[i], ids[j]] = [ids[j], ids[i]]; }
    this.entrants = ids;
    this.status = 'active';
    this.rounds = [this._seedRound(ids)];
    this.broadcastState();
    this._playNext();
    return true;
  }

  // Pair ids sequentially; an odd one out gets a bye (auto-advances).
  _seedRound(ids) {
    const round = [];
    for (let i = 0; i < ids.length; i += 2) {
      const a = ids[i], b = ids[i + 1];
      if (b == null) round.push({ id: ++this._seq, a, b: null, bye: true, winner: a });
      else round.push({ id: ++this._seq, a, b, bye: false, winner: null });
    }
    return round;
  }

  _curRound() { return this.rounds[this.rounds.length - 1]; }

  // Drive the bracket forward: play the next unresolved match in the current
  // round, else build the next round from the winners, else crown the champion.
  _playNext() {
    if (this.status !== 'active') return;
    const round = this._curRound();
    const next = round.find((m) => !m.bye && m.winner == null);
    if (next) { this._startMatch(next); return; }
    const winners = round.map((m) => m.winner);
    if (winners.length <= 1) {
      this.champion = winners[0] ?? null;
      this.status = 'done';
      this.current = null;
      this.broadcastState();
      this._announceChampion();
      return;
    }
    this.rounds.push(this._seedRound(winners));
    this.broadcastState();
    this._playNext();
  }

  _startMatch(m) {
    const ca = this.connOf(m.a), cb = this.connOf(m.b);
    const cap = this.lobby.mapCap(this.arenaMap());
    const aOk = ca && ca.alive, bOk = cb && cb.alive;
    // A missing combatant forfeits to the other, keeping the bracket moving.
    if (!aOk || !bOk) { m.winner = aOk ? m.a : (bOk ? m.b : m.a); this.broadcastState(); this._scheduleNext(); return; }
    const pa = this.lobby.players[m.a], pb = this.lobby.players[m.b];
    ca._name = (pa.save.name || 'Player'); ca._team = teamFromSave(pa.save, cap);
    cb._name = (pb.save.name || 'Player'); cb._team = teamFromSave(pb.save, cap);
    if (!validTeam(ca._team) || !validTeam(cb._team)) { m.winner = validTeam(ca._team) ? m.a : m.b; this.broadcastState(); this._scheduleNext(); return; }
    this.current = m;
    this.broadcastState();   // announce the live match BEFORE the room emits frames
    const self = this;
    try {
      this.room = new GameRoom(ca, cb, this.dex, {
        matchInfo: { tournament: true, code: this.code },
        spectators: () => self._spectatorConns(m),
        onEnd: (winnerSide) => {
          const w = (winnerSide === 'tie' || winnerSide == null) ? ((Math.random() < 0.5) ? 0 : 1) : winnerSide;
          m.winner = w === 0 ? m.a : m.b;
          if (pa) pa.save.battledToday = true;   // a tournament bout counts as a battle
          if (pb) pb.save.battledToday = true;
          // The match winner earns EV candies for the team they just beat.
          const winnerConn = w === 0 ? ca : cb;
          const loserTeam = w === 0 ? cb._team : ca._team;
          try { winnerConn.send({ t: 'evCandies', species: (loserTeam || []).map((t) => t.species) }); } catch { /* ignore */ }
          self.reg.persist(self.code);
          self.room = null; self.current = null;
          self.broadcastState();
          self._scheduleNext();
        },
      });
    } catch {
      m.winner = m.a; this.room = null; this.current = null;
      this.broadcastState(); this._scheduleNext();
    }
  }

  _scheduleNext() {
    if (this.status !== 'active') return;
    const t = setTimeout(() => { try { this._playNext(); } catch { /* keep bracket alive */ } }, this.matchDelayMs);
    if (t && t.unref) t.unref();
  }

  // Live arena conns that are NOT the two combatants of match m.
  _spectatorConns(m) {
    const out = [];
    const map = this.reg.live.get(this.code);
    if (!map) return out;
    const arena = this.arenaMap();
    for (const conn of map.values()) {
      if (conn._playerId === m.a || conn._playerId === m.b) continue;
      if (!conn._pres || conn._pres.map !== arena) continue;
      out.push(conn);
    }
    return out;
  }

  _announceChampion() {
    const map = this.reg.live.get(this.code);
    if (!map) return;
    const msg = { t: 'champion', playerId: this.champion, name: this.champion ? this.nameOf(this.champion) : null };
    for (const conn of map.values()) { try { conn.send(msg); } catch { /* socket gone */ } }
  }

  // A client-facing snapshot of the bracket (names resolved for rendering).
  snapshot() {
    return {
      status: this.status,
      arenaMap: this.arenaMap(),
      hostId: this.lobby.hostId || null,
      ready: [...this.ready],
      present: this.presentIds(),
      entrants: this.entrants.map((id) => ({ id, name: this.nameOf(id) })),
      rounds: this.rounds.map((r) => r.map((m) => ({
        id: m.id,
        a: m.a, aName: m.a ? this.nameOf(m.a) : null,
        b: m.b, bName: m.b ? this.nameOf(m.b) : null,
        bye: !!m.bye, winner: m.winner || null,
      }))),
      current: this.current ? { id: this.current.id, a: this.current.a, aName: this.nameOf(this.current.a), b: this.current.b, bName: this.nameOf(this.current.b) } : null,
      champion: this.champion,
      championName: this.champion ? this.nameOf(this.champion) : null,
    };
  }

  broadcastState() {
    const map = this.reg.live.get(this.code);
    if (!map) return;
    const snap = this.snapshot();
    for (const conn of map.values()) { try { conn.send({ t: 'tournamentState', tournament: snap }); } catch { /* socket gone */ } }
  }
}

// Week-end transition (Task 18 → 19): teleport everyone in a locked week lobby
// onto the arena spawn and open tournament gathering. Idempotent per lobby.
export function beginArenaTournament(lobby) {
  if (!lobby || TOURNAMENTS.has(lobby.code)) return TOURNAMENTS.get(lobby.code);
  const arena = lobby.world.progression.arenaMap;
  const am = lobby.world.mapById[arena];
  const spawn = (am && am.spawn) || { x: 0, y: 0 };
  for (const p of Object.values(lobby.players)) {
    p.save.map = arena; p.save.x = spawn.x; p.save.y = spawn.y; p.save.facing = 'up';
  }
  REGISTRY.persist(lobby.code);
  const t = new Tournament(lobby, DEX, REGISTRY, { matchDelayMs: REGISTRY.tournamentMatchDelayMs });
  TOURNAMENTS.set(lobby.code, t);
  // Push every live player into the arena; their presence updates then mark
  // them "present" so the gather gate (and spectator fan-out) can see them.
  const map = REGISTRY.live.get(lobby.code);
  if (map) for (const conn of map.values()) {
    try { conn.send({ t: 'enterArena', map: arena, x: spawn.x, y: spawn.y, tournament: t.snapshot() }); } catch { /* socket gone */ }
  }
  return t;
}

// Ensure a (gathering) tournament exists for a lobby — used by free-mode arena
// entry, where players gather voluntarily rather than being locked in.
function ensureTournament(lobby) {
  let t = TOURNAMENTS.get(lobby.code);
  if (!t) { t = new Tournament(lobby, DEX, REGISTRY, { matchDelayMs: REGISTRY.tournamentMatchDelayMs }); TOURNAMENTS.set(lobby.code, t); }
  return t;
}

// ---------------------------------------------------------------------------
//  Boot
// ---------------------------------------------------------------------------
export async function start(port = PORT) {
  await ensureDex();
  await ensureRegistry();
  REGISTRY.startScheduler();   // week-mode day clock (Task 18)
  const server = http.createServer(serveStatic);
  // A malformed HTTP request must not crash the process.
  server.on('clientError', (_err, socket) => { try { socket.destroy(); } catch { /* ignore */ } });
  server.on('upgrade', (req, socket) => {
    // Raw upgrade sockets emit 'error' with no default listener → would crash.
    socket.on('error', () => { try { socket.destroy(); } catch { /* ignore */ } });
    try {
      const key = req.headers['sec-websocket-key'];
      if (!key) { socket.destroy(); return; }
      const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
      socket.write([
        'HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`, '\r\n',
      ].join('\r\n'));
      handleConnection(new WSConn(socket));
    } catch (err) {
      console.error('[server] upgrade failed:', (err && err.message) || err);
      try { socket.destroy(); } catch { /* ignore */ }
    }
  });
  await new Promise((res, rej) => {
    server.once('error', rej); // surface listen errors (e.g. EADDRINUSE) to start()
    server.listen(port, () => {
      server.off('error', rej);
      // Once listening, downgrade later server errors to logs so they can't crash us.
      server.on('error', (err) => console.error('[server] http server error:', (err && err.message) || err));
      console.log(`PokeWeek online server running at http://localhost:${port}`);
      console.log('Create or join a lobby by 6-digit code; saves persist to saves/<code>.json.');
      res();
    });
  });
  return server;
}

// Flush pending debounced writes on shutdown so no save is lost.
let _shuttingDown = false;
async function gracefulExit() {
  if (_shuttingDown) return;
  _shuttingDown = true;
  try { if (REGISTRY) REGISTRY.stopScheduler(); } catch { /* ignore */ }
  try { await flushAll(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', gracefulExit);
process.on('SIGTERM', gracefulExit);

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) start().catch((err) => { console.error('[server] failed to start:', (err && err.stack) || err); process.exit(1); });
