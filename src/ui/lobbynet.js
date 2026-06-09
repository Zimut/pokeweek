// Client side of the lobby protocol. Wraps a WebSocket with promise-based
// create / join / resume calls and a debounced save sender, and persists the
// player's { playerId, secret } identity in localStorage (keyed by lobby code)
// so a refresh can silently reconnect and resume exactly where they were.
//
// The actual game still simulates locally (GameController); this layer makes
// the server the durable owner of each player's save + the lobby config.
import { connect } from './net.js';

const LS_KEY = 'pokeweek.identities';
// The single lobby the player is currently "in". Set whenever a game is
// entered (create / join / resume) and cleared only by an explicit quit to the
// main menu, so a refresh re-enters this lobby directly instead of the home
// screen. To switch lobbies the player must first leave to the menu.
const LS_ACTIVE = 'pokeweek.activeLobby';

// Server message types that belong to an in-progress PvP battle (routed to the
// NetworkBattleView, not the presence/invite push handler). `matched` and
// `pvpResult` are intentionally excluded: they start/settle the battle and are
// handled by the game controller.
const BATTLE_TYPES = new Set(['events', 'request', 'waitOpp', 'end', 'oppLeft', 'error']);

// ---- localStorage identity store ------------------------------------------
export function loadIdentities() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; }
  catch { return {}; }
}
function saveIdentities(map) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(map)); } catch { /* private mode */ }
}
export function rememberIdentity(code, identity) {
  const all = loadIdentities();
  all[code] = { code, playerId: identity.playerId, secret: identity.secret, name: identity.name, at: Date.now() };
  saveIdentities(all);
}
export function forgetIdentity(code) {
  const all = loadIdentities();
  delete all[code];
  saveIdentities(all);
}
// Most-recently-used saved identities (for the "Resume" list).
export function recentIdentities() {
  return Object.values(loadIdentities()).sort((a, b) => (b.at || 0) - (a.at || 0));
}

// ---- active lobby (auto-resume on refresh) --------------------------------
export function setActiveLobby(code) {
  try { localStorage.setItem(LS_ACTIVE, code); } catch { /* private mode */ }
}
export function getActiveLobby() {
  try { return localStorage.getItem(LS_ACTIVE) || null; } catch { return null; }
}
export function clearActiveLobby() {
  try { localStorage.removeItem(LS_ACTIVE); } catch { /* ignore */ }
}

export function lobbyWsUrl() {
  // Connect to this page's own directory so the app works under a sub-path
  // (e.g. /pokeweek/) as well as at the web root. The trailing path is the
  // current document folder; a reverse proxy maps it back to the server.
  const dir = location.pathname.replace(/[^/]*$/, '');
  return (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + dir;
}

// A single connection used for the whole lobby session. Request/response calls
// resolve on the matching reply; unsolicited server pushes (presence, day
// events, PvP invites — Tasks 17/18) are delivered to onPush.
export class LobbyConnection {
  constructor(url = lobbyWsUrl()) {
    this.conn = connect(url);
    this.code = null;
    this.playerId = null;
    this.secret = null;
    this.config = null;
    this.onPush = null;       // (msg) => void  — presence / invites / day pushes
    this.onClose = null;
    this._waiters = [];       // { match:(m)=>bool, resolve, reject }
    this._battle = null;      // active PvP battle adapter (routes engine msgs)
    this._saveTimer = null;
    this._openP = new Promise((res, rej) => { this._openRes = res; this._openRej = rej; });

    this.conn.onOpen = () => this._openRes();
    this.conn.onClose = () => {
      const err = new Error('Connection closed.');
      this._waiters.splice(0).forEach((w) => w.reject(err));
      if (this.onClose) this.onClose();
    };
    this.conn.onMessage = (m) => this._dispatch(m);
  }

  ready() { return this._openP; }

  _dispatch(m) {
    // First matching waiter wins (request/response calls like createLobby).
    const i = this._waiters.findIndex((w) => w.match(m));
    if (i >= 0) {
      const [w] = this._waiters.splice(i, 1);
      if (m.t === 'error') w.reject(Object.assign(new Error(m.msg || 'Error'), { code: m.code }));
      else w.resolve(m);
      return;
    }
    // An active PvP battle owns the engine message stream.
    if (this._battle && BATTLE_TYPES.has(m.t)) { this._battle.onMessage(m); return; }
    // Everything else is a presence/invite/day push for the game controller.
    if (this.onPush) this.onPush(m);
  }

  // Begin routing server battle frames to a NetworkBattleView. Returns a
  // connection adapter the view can drive (send choices, "close" = leave) that
  // never tears down the shared lobby socket.
  beginPvp() {
    const self = this;
    this._battle = {
      ws: { close() { try { self.conn.send({ t: 'pvpLeave' }); } catch { /* ignore */ } } },
      send: (o) => self.conn.send(o),
      onMessage: null,
      onClose: null,
    };
    return this._battle;
  }

  endPvp() { this._battle = null; }

  // ---- presence + PvP invites (fire-and-forget) --------------------------
  sendPresence(pos) {
    if (!this.code) return;
    this.conn.send({ t: 'presence', map: pos.map, x: pos.x, y: pos.y, facing: pos.facing });
  }
  sendChat(text) { if (this.code) this.conn.send({ t: 'chat', text: String(text).slice(0, 120) }); }
  // Request another player's card (name / money / team). Resolves on the reply.
  async getPlayerCard(playerId) {
    if (!this.code) throw new Error('Not in a lobby.');
    this.conn.send({ t: 'playerCard', playerId });
    return this._await('playerCard');
  }
  invitePvp(toPlayerId) { if (this.code) this.conn.send({ t: 'invitePvp', toPlayerId }); }
  acceptPvp(fromPlayerId) { if (this.code) this.conn.send({ t: 'acceptPvp', fromPlayerId }); }
  declinePvp(fromPlayerId) { if (this.code) this.conn.send({ t: 'declinePvp', fromPlayerId }); }
  cancelPvp() { if (this.code) this.conn.send({ t: 'cancelPvp' }); }

  // ---- tournament arena (Task 19) ----------------------------------------
  tournamentEnter() { if (this.code) this.conn.send({ t: 'tournamentEnter' }); }
  tournamentReady() { if (this.code) this.conn.send({ t: 'tournamentReady' }); }
  tournamentStart() { if (this.code) this.conn.send({ t: 'tournamentStart' }); }
  tournamentSync() { if (this.code) this.conn.send({ t: 'tournamentSync' }); }

  // Resolve on the first message whose type is in `types`, or reject on 'error'.
  _await(types, timeoutMs = 8000) {
    const set = new Set([].concat(types));
    return new Promise((resolve, reject) => {
      const w = {
        match: (m) => set.has(m.t) || m.t === 'error',
        resolve, reject,
      };
      this._waiters.push(w);
      setTimeout(() => {
        const idx = this._waiters.indexOf(w);
        if (idx >= 0) { this._waiters.splice(idx, 1); reject(new Error('Server timed out.')); }
      }, timeoutMs);
    });
  }

  _store(m) {
    this.code = m.code;
    this.playerId = m.playerId;
    this.config = m.config;
    if (m.secret) this.secret = m.secret;
    if (m.secret) rememberIdentity(m.code, { playerId: m.playerId, secret: m.secret, name: (m.save && m.save.name) });
  }

  async createLobby(opts) {
    await this.ready();
    this.conn.send({ t: 'createLobby', ...opts });
    const m = await this._await('lobbyCreated');
    this._store(m);
    return m; // { code, playerId, secret, config, save }
  }

  async joinLobby(code, opts) {
    await this.ready();
    this.conn.send({ t: 'joinLobby', code, ...opts });
    const m = await this._await('joined');
    this._store(m);
    return m;
  }

  async resume(code, playerId, secret) {
    await this.ready();
    this.conn.send({ t: 'auth', code, playerId, secret });
    const m = await this._await('resumed');
    this.code = m.code; this.playerId = m.playerId; this.secret = secret; this.config = m.config;
    return m; // { code, playerId, config, save }
  }

  // Fire-and-forget save (server debounces writes). Debounced here too so a
  // burst of steps coalesces into one frame.
  saveState(save) {
    if (!this.code) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this.conn.send({ t: 'saveState', save });
    }, 600);
  }

  // Immediate save (battle end, purchase, map change) — bypasses the debounce.
  saveNow(save) {
    if (!this.code) return;
    clearTimeout(this._saveTimer);
    this.conn.send({ t: 'saveState', save });
  }

  leave() {
    if (this.code) this.conn.send({ t: 'leaveLobby' });
    this.code = this.playerId = this.secret = this.config = null;
  }

  close() { try { this.conn.ws.close(); } catch { /* ignore */ } }
}
