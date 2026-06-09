// Per-lobby world state + the lobby registry.
//
// A Lobby is a shared game instance: a 6-digit join code, a mode (free|week),
// host-chosen day length + Poké Ball allowance, the current unlocked-map index,
// and a save per player keyed by a minted { playerId, secret } identity.
//
// The client simulates single-player actions (walking, catching, trainer/gym
// battles) and reports its save back; the server is the authority for identity
// and durability (it owns the only copy that survives a refresh) and for
// lobby-wide config (mode / ball allowance / unlocked map / day schedule). PvP
// stays fully server-authoritative via the existing battle rooms.
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toId } from '../src/engine/dex.js';
import { loadAllSaves, scheduleSave, writeSave, deleteSave } from './persist.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
//  World content (progression + map spawns) — read once, shared by all lobbies
// ---------------------------------------------------------------------------
let WORLD = null;
export async function ensureWorld() {
  if (WORLD) return WORLD;
  const dir = join(__dirname, '..', 'src', 'data', 'world');
  const [progression, maps] = await Promise.all([
    readFile(join(dir, 'progression.json'), 'utf8').then(JSON.parse),
    readFile(join(dir, 'maps.json'), 'utf8').then(JSON.parse),
  ]);
  const mapById = {};
  for (const m of maps) mapById[m.map] = m;
  WORLD = { progression, mapById };
  return WORLD;
}

const DAY_PRESETS = { '1min': 60000, '1hour': 3600000, '24hour': 86400000 };
const newId = () => crypto.randomBytes(9).toString('base64url'); // ~12 chars
const newSecret = () => crypto.randomBytes(18).toString('base64url');

// Normalise a requested ball allowance. The lobby UI offers a 5–99 slider whose
// last notch means unlimited, so we accept any integer (clamped to 1–99) plus
// the "infinite" sentinel; anything unparseable falls back to 25.
function normalizeAllowance(progression, req) {
  if (req === 'infinite' || req === 'Infinity') return 'infinite';
  const n = Math.round(Number(req));
  if (Number.isFinite(n)) return Math.max(1, Math.min(99, n));
  return 25;
}

// Starting Poké Ball count for a fresh map. Stored as "infinite" (a JSON-safe
// sentinel) when the allowance is unlimited; the client maps it to Infinity.
function startingBalls(allowance) {
  return { pokeball: allowance === 'infinite' ? 'infinite' : allowance, greatball: 0 };
}

export class Lobby {
  constructor(code, opts, world, dex) {
    this.world = world;
    this.dex = dex;
    this.code = code;
    this.mode = opts.mode === 'week' ? 'week' : 'free';
    this.dayLengthMs = DAY_PRESETS[opts.dayLength] || Number(opts.dayLengthMs) || world.progression.dayDefaultMs || 86400000;
    this.ballAllowance = normalizeAllowance(world.progression, opts.ballAllowance);
    // Free mode opens every route from the start (still badge-gated); week mode
    // unlocks map 1 only and the day scheduler reveals the rest (Task 18).
    this.unlockedMap = this.mode === 'week' ? 1 : world.progression.mapCount;
    this.dayIndex = 0;
    this.dayStartedAt = Date.now();
    // A week lasts one day per route; after the final day the lobby locks
    // (no more progression / PvP — final standings are settled).
    this.weekLength = world.progression.weekDays || world.progression.mapCount;
    this.locked = false;
    this.createdAt = Date.now();
    this.hostId = null;           // the lobby creator (may force-start the tournament)
    this.tournament = null;       // populated in Task 19
    this.players = {};            // playerId -> { secret, save }
  }

  // The lobby-level config the client needs to drive its session.
  publicConfig() {
    return {
      code: this.code,
      mode: this.mode,
      ballAllowance: this.ballAllowance,
      unlockedMap: this.unlockedMap,
      mapCount: this.world.progression.mapCount,
      arenaMap: this.world.progression.arenaMap,
      dayLengthMs: this.dayLengthMs,
      dayIndex: this.dayIndex,
      dayStartedAt: this.dayStartedAt,
      weekLength: this.weekLength,
      locked: this.locked,
      playerCount: Object.keys(this.players).length,
    };
  }

  // Build the initial save for a brand-new player: starter at Lv5 on map 1's
  // spawn, ₽0, this map's ball allowance, nothing caught but the starter.
  initialSave({ name, starter, character }) {
    const prog = this.world.progression;
    const starters = prog.starters;
    const sid = toId(starter && starters.includes(toId(starter)) ? toId(starter) : starters[0]);
    const m1 = this.world.mapById[1];
    const spawn = (m1 && m1.spawn) || { x: 0, y: 0 };
    return {
      name: (name && String(name).trim().slice(0, 20)) || 'Player',
      character: normalizeCharacter(character),
      map: 1, x: spawn.x, y: spawn.y, facing: 'up',
      money: prog.startMoney || 0,
      badges: {}, beatenTrainers: {},
      party: [{
        species: sid, level: 5, shiny: false,
        ivs: { hp: 15, atk: 15, def: 15, spa: 15, spd: 15, spe: 15 }, // starters: a fixed 15/31
        evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
        moves: this.dex.defaultMoves(sid, 5),
      }],
      box: [], bag: {}, candies: {},
      balls: startingBalls(this.ballAllowance),
      caught: { [sid]: true },
      battledToday: false,
    };
  }

  // Mint identity + initial save and register the player. Returns the identity.
  addPlayer(opts) {
    const playerId = newId();
    const secret = newSecret();
    const save = this.initialSave(opts);
    this.players[playerId] = { secret, save };
    return { playerId, secret, save };
  }

  authPlayer(playerId, secret) {
    const p = this.players[playerId];
    if (!p || p.secret !== secret) return null;
    return p;
  }

  // Effective level cap for a map (PvP teams are clamped to the shared map cap).
  mapCap(map) {
    const m = (this.world.progression.maps || []).find((x) => x.map === map);
    return m ? m.cap : 100;
  }

  // Apply a finished PvP result to two players' saved money. Winner +pvpWin,
  // loser +pvpLose (negative; balances may go negative). Returns per-player
  // deltas + new totals so the server can echo them to each client.
  applyPvpResult(idA, idB, winnerSide) {
    const rewards = this.world.progression.rewards || {};
    const win = rewards.pvpWin ?? 1000;
    const lose = rewards.pvpLose ?? -1000;
    const a = this.players[idA], b = this.players[idB];
    const out = {};
    if (a) a.save.battledToday = true;
    if (b) b.save.battledToday = true;
    if (winnerSide === 'tie' || winnerSide == null) {
      out[idA] = { delta: 0, money: a ? a.save.money : 0, result: 'tie' };
      out[idB] = { delta: 0, money: b ? b.save.money : 0, result: 'tie' };
      return out;
    }
    const winId = winnerSide === 0 ? idA : idB;
    const loseId = winnerSide === 0 ? idB : idA;
    const w = this.players[winId], l = this.players[loseId];
    if (w) { w.save.money = (w.save.money || 0) + win; out[winId] = { delta: win, money: w.save.money, result: 'win' }; }
    if (l) { l.save.money = (l.save.money || 0) + lose; out[loseId] = { delta: lose, money: l.save.money, result: 'lose' }; }
    return out;
  }

  // Advance the week-mode day schedule up to `now`, catching up any whole days
  // that have elapsed (e.g. while the server was offline). Each day boundary:
  //   • penalises every player who did NOT battle that day (dailyPenalty, may go
  //     negative) and resets their battle flag for the new day,
  //   • reveals the next route (unlockedMap += 1, capped at mapCount),
  //   • after the final route the lobby locks (no more progression / PvP).
  // Returns a change summary (or null if nothing happened) so the registry can
  // broadcast a `dayAdvanced` push and persist. Pure w.r.t. `now` for testing.
  tickSchedule(now = Date.now()) {
    if (this.mode !== 'week' || this.locked) return null;
    const penalty = (this.world.progression.rewards || {}).dailyPenalty ?? -2000;
    const mapCount = this.world.progression.mapCount;
    const penalties = {};      // playerId -> { delta, money }  (penalised only)
    let advanced = 0;
    while (!this.locked && now - this.dayStartedAt >= this.dayLengthMs) {
      // Settle the day that just ended before opening the next one.
      for (const [id, p] of Object.entries(this.players)) {
        if (!p.save.battledToday) {
          p.save.money = (p.save.money || 0) + penalty;
          const acc = penalties[id] || { delta: 0, money: 0 };
          acc.delta += penalty; acc.money = p.save.money;
          penalties[id] = acc;
        }
        p.save.battledToday = false;
      }
      this.dayIndex += 1;
      this.dayStartedAt += this.dayLengthMs;
      advanced += 1;
      if (this.dayIndex >= this.weekLength) { this.locked = true; break; }
      this.unlockedMap = Math.min(this.dayIndex + 1, mapCount);
    }
    if (!advanced) return null;
    return { daysAdvanced: advanced, locked: this.locked, config: this.publicConfig(), penalties };
  }

  // Replace a player's save with a client-reported snapshot (shallow validated).
  updateSave(playerId, save) {
    const p = this.players[playerId];
    if (!p || !save || typeof save !== 'object') return false;
    p.save = sanitizeSave(save, p.save);
    return true;
  }

  // Serialize for persistence (the entire lobby fits one JSON file).
  serialize() {
    return {
      code: this.code,
      mode: this.mode,
      dayLengthMs: this.dayLengthMs,
      ballAllowance: this.ballAllowance,
      unlockedMap: this.unlockedMap,
      dayIndex: this.dayIndex,
      dayStartedAt: this.dayStartedAt,
      locked: this.locked,
      createdAt: this.createdAt,
      hostId: this.hostId,
      tournament: this.tournament,
      players: this.players,
    };
  }

  static deserialize(data, world, dex) {
    const lobby = new Lobby(data.code, {
      mode: data.mode,
      dayLengthMs: data.dayLengthMs,
      ballAllowance: data.ballAllowance,
    }, world, dex);
    lobby.unlockedMap = data.unlockedMap ?? lobby.unlockedMap;
    lobby.dayIndex = data.dayIndex ?? 0;
    lobby.dayStartedAt = data.dayStartedAt ?? Date.now();
    lobby.locked = !!data.locked;
    lobby.createdAt = data.createdAt ?? Date.now();
    lobby.hostId = data.hostId ?? null;
    lobby.tournament = data.tournament ?? null;
    lobby.players = (data.players && typeof data.players === 'object') ? data.players : {};
    return lobby;
  }
}

// Keep only the fields we persist, and never let a client shrink to nonsense
// (e.g. an empty party). Falls back to the previous save's value when invalid.
function sanitizeSave(save, prev) {
  const out = {
    name: typeof save.name === 'string' ? save.name.slice(0, 20) : prev.name,
    character: normalizeCharacter(save.character ?? prev.character),
    map: Number.isFinite(save.map) ? save.map : prev.map,
    x: Number.isFinite(save.x) ? save.x : prev.x,
    y: Number.isFinite(save.y) ? save.y : prev.y,
    facing: typeof save.facing === 'string' ? save.facing : prev.facing,
    money: Number.isFinite(save.money) ? save.money : prev.money,
    badges: (save.badges && typeof save.badges === 'object') ? save.badges : prev.badges,
    beatenTrainers: (save.beatenTrainers && typeof save.beatenTrainers === 'object') ? save.beatenTrainers : prev.beatenTrainers,
    party: (Array.isArray(save.party) && save.party.length >= 1) ? save.party : prev.party,
    box: Array.isArray(save.box) ? save.box : prev.box,
    bag: (save.bag && typeof save.bag === 'object') ? save.bag : prev.bag,
    balls: (save.balls && typeof save.balls === 'object') ? save.balls : prev.balls,
    candies: (save.candies && typeof save.candies === 'object') ? save.candies : (prev.candies || {}),
    caught: (save.caught && typeof save.caught === 'object') ? save.caught : prev.caught,
    battledToday: typeof save.battledToday === 'boolean' ? save.battledToday : (prev.battledToday || false),
  };
  return out;
}

const CHARACTERS = ['red', 'blue', 'green', 'gold', 'silver', 'kris'];
function normalizeCharacter(c) { return CHARACTERS.includes(c) ? c : 'red'; }
export { CHARACTERS };

// ---------------------------------------------------------------------------
//  Registry: minting codes, create/join/auth, persistence wiring
// ---------------------------------------------------------------------------
export class LobbyRegistry {
  constructor(world, dex) {
    this.world = world;
    this.dex = dex;
    this.lobbies = new Map(); // code -> Lobby
    // Runtime-only presence: code -> Map(playerId -> live WSConn). Never
    // persisted — it tracks who is currently connected and where they stand so
    // peers on the same map can see + challenge each other (Task 17).
    this.live = new Map();
    this._schedTimer = null;   // week-mode day scheduler (Task 18)
    // Week-end hook (Task 19): set by server.mjs to launch the arena tournament
    // when a week-mode lobby locks. Kept here so world.js stays engine-free and
    // server.mjs owns the GameRoom-backed Tournament (no circular import).
    this.onWeekEnd = null;     // (lobby) => void
    this.tournamentMatchDelayMs = undefined; // optional override (tests)
  }

  // Restore all saved lobbies from disk on boot.
  async loadFromDisk() {
    const all = await loadAllSaves();
    for (const [code, data] of Object.entries(all)) {
      try { this.lobbies.set(code, Lobby.deserialize(data, this.world, this.dex)); }
      catch { /* skip unreadable lobby */ }
    }
    return this.lobbies.size;
  }

  mintCode() {
    for (let i = 0; i < 10000; i++) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      if (!this.lobbies.has(code)) return code;
    }
    throw new Error('Could not mint a unique lobby code.');
  }

  get(code) { return this.lobbies.get(String(code)); }

  createLobby(opts) {
    const code = this.mintCode();
    const lobby = new Lobby(code, opts, this.world, this.dex);
    this.lobbies.set(code, lobby);
    const identity = lobby.addPlayer(opts);
    lobby.hostId = identity.playerId;   // the creator hosts (may force-start)
    this.persist(code);
    return { lobby, identity };
  }

  // Join an existing lobby as a new player. Returns null if the code is unknown.
  joinLobby(code, opts) {
    const lobby = this.get(code);
    if (!lobby) return null;
    const identity = lobby.addPlayer(opts);
    this.persist(code);
    return { lobby, identity };
  }

  // Resume: validate identity and hand back the saved snapshot.
  auth(code, playerId, secret) {
    const lobby = this.get(code);
    if (!lobby) return null;
    const player = lobby.authPlayer(playerId, secret);
    if (!player) return null;
    return { lobby, player };
  }

  saveState(code, playerId, save) {
    const lobby = this.get(code);
    if (!lobby) return false;
    const ok = lobby.updateSave(playerId, save);
    if (ok) this.persist(code);
    return ok;
  }

  // Debounced persistence of a lobby's current full state.
  persist(code) {
    const lobby = this.get(code);
    if (!lobby) return;
    scheduleSave(code, () => lobby.serialize());
  }

  // Immediate write (e.g. tests / shutdown of a single lobby).
  async persistNow(code) {
    const lobby = this.get(code);
    if (lobby) await writeSave(code, lobby.serialize());
  }

  async removeLobby(code) {
    this.lobbies.delete(String(code));
    await deleteSave(String(code));
  }

  // ---- live presence (runtime only; Task 17) -----------------------------
  _liveFor(code) {
    let m = this.live.get(code);
    if (!m) { m = new Map(); this.live.set(code, m); }
    return m;
  }

  // Register a live connection for a player (called once they create/join/auth).
  // A second tab with the same identity simply replaces the first.
  registerConn(conn) {
    if (!conn._lobbyCode || !conn._playerId) return;
    this._liveFor(conn._lobbyCode).set(conn._playerId, conn);
  }

  // Find a player's live connection (for PvP invites).
  connFor(code, playerId) {
    const m = this.live.get(code);
    return m ? m.get(playerId) || null : null;
  }

  // A peer descriptor others render: identity + name/character (from the save)
  // + current tile position/facing (from the live connection).
  peerInfo(conn) {
    const lobby = this.get(conn._lobbyCode);
    const p = lobby && lobby.players[conn._playerId];
    const save = (p && p.save) || {};
    const pr = conn._pres || {};
    return {
      id: conn._playerId,
      name: save.name || 'Player',
      character: normalizeCharacter(save.character),
      x: pr.x | 0, y: pr.y | 0, facing: pr.facing || 'down',
    };
  }

  // Everyone (besides `exceptId`) standing on `map` in this lobby right now.
  peersOnMap(code, map, exceptId) {
    const out = [];
    const m = this.live.get(code);
    if (!m) return out;
    for (const c of m.values()) {
      if (c._playerId === exceptId) continue;
      if (!c._pres || c._pres.map !== map) continue;
      out.push(this.peerInfo(c));
    }
    return out;
  }

  // Send a message to every live peer on `map` except `exceptId`.
  broadcastToMap(code, map, exceptId, msg) {
    const m = this.live.get(code);
    if (!m) return;
    for (const c of m.values()) {
      if (c._playerId === exceptId) continue;
      if (!c._pres || c._pres.map !== map) continue;
      try { c.send(msg); } catch { /* socket gone */ }
    }
  }

  // Push a fresh full peer roster to every live player on `map` (each gets the
  // list with themselves excluded). Used whenever the population of a map
  // changes, so nobody can miss a join/leave due to a dropped incremental update.
  syncMapRoster(code, map) {
    const m = this.live.get(code);
    if (!m) return;
    for (const c of m.values()) {
      if (!c._pres || c._pres.map !== map) continue;
      try { c.send({ t: 'peers', map, list: this.peersOnMap(code, map, c._playerId) }); } catch { /* socket gone */ }
    }
  }

  // Record a player's position. Entering a map (join or map-change) pushes a
  // fresh full roster to everyone now on that map — so existing players see a
  // newcomer immediately, without waiting to move (this is the reliable fix for
  // a dropped one-off join notification). Leaving a map tells its residents to
  // drop the leaver; a move within a map just broadcasts the new tile.
  updatePresence(conn, pos) {
    const code = conn._lobbyCode;
    if (!code || !conn._playerId) return;
    const map = pos.map | 0;
    const next = { map, x: pos.x | 0, y: pos.y | 0, facing: typeof pos.facing === 'string' ? pos.facing : 'down' };
    const prev = conn._pres;
    conn._pres = next;
    this._liveFor(code).set(conn._playerId, conn);
    if (!prev || prev.map !== map) {
      if (prev) this.broadcastToMap(code, prev.map, conn._playerId, { t: 'peerLeave', id: conn._playerId });
      this.syncMapRoster(code, map);
    } else {
      this.broadcastToMap(code, map, conn._playerId, { t: 'peerMove', id: conn._playerId, x: next.x, y: next.y, facing: next.facing });
    }
  }

  // Drop a connection from presence (on disconnect / leave). Guards against a
  // stale tab evicting the live connection that replaced it.
  detachPresence(conn) {
    const code = conn._lobbyCode;
    if (!code || !conn._playerId) return;
    const m = this.live.get(code);
    if (m && m.get(conn._playerId) === conn) m.delete(conn._playerId);
    if (conn._pres) {
      this.broadcastToMap(code, conn._pres.map, conn._playerId, { t: 'peerLeave', id: conn._playerId });
    }
    conn._pres = null;
  }

  // ---- week-mode day scheduler (Task 18) ----------------------------------
  // Advance every lobby's day schedule, broadcasting + persisting any change.
  tickAll(now = Date.now()) {
    for (const lobby of this.lobbies.values()) {
      const res = lobby.tickSchedule(now);
      if (!res) continue;
      this._broadcastDay(lobby, res);
      this.persist(lobby.code);
      // The final day locks the lobby → hand off to the arena tournament.
      if (res.locked && typeof this.onWeekEnd === 'function') {
        try { this.onWeekEnd(lobby); } catch { /* tournament launch is best-effort */ }
      }
    }
  }

  // Tell every live player in a lobby that the day advanced. Each gets their own
  // penalty line (or null) plus the refreshed lobby config (unlockedMap, locked…).
  _broadcastDay(lobby, res) {
    const m = this.live.get(lobby.code);
    if (!m) return;
    for (const conn of m.values()) {
      const penalty = res.penalties[conn._playerId] || null;
      try { conn.send({ t: 'dayAdvanced', daysAdvanced: res.daysAdvanced, locked: res.locked, config: res.config, penalty }); }
      catch { /* socket gone */ }
    }
  }

  // Run the day scheduler on a wall-clock interval. Unref'd so it never keeps a
  // test/process alive; catch-up math handles a coarse interval just fine.
  startScheduler(intervalMs = 1000) {
    if (this._schedTimer) return;
    this._schedTimer = setInterval(() => { try { this.tickAll(); } catch { /* keep ticking */ } }, intervalMs);
    if (this._schedTimer.unref) this._schedTimer.unref();
  }

  stopScheduler() {
    if (this._schedTimer) { clearInterval(this._schedTimer); this._schedTimer = null; }
  }
}
