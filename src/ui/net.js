// Client side of online PvP. The server owns the authoritative Battle; this
// view never runs the engine. It connects over WebSocket, animates the event
// stream the server sends, and replies to each "request" with the player's
// chosen action. It reuses all of BattleView's rendering/animation code and
// only overrides the few methods that previously read a local `this.battle`.
import { BattleView } from './battle.js';

// Open a WebSocket and expose a tiny JSON message API.
export function connect(url) {
  const ws = new WebSocket(url);
  const api = { ws, onOpen: null, onMessage: null, onClose: null, send: (o) => { try { ws.send(JSON.stringify(o)); } catch { /* not open */ } } };
  ws.onopen = () => api.onOpen && api.onOpen();
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } api.onMessage && api.onMessage(m); };
  ws.onclose = () => api.onClose && api.onClose();
  ws.onerror = () => { /* surfaced via onclose */ };
  return api;
}

export class NetworkBattleView extends BattleView {
  constructor(dex, conn, onExit) {
    // controllers[0]='human' (this client), [1]='net' (the remote player) — the
    // single local human means action menus render without a name prefix.
    super(dex, { kind: 'online', controllers: ['human', 'net'], names: ['You', 'Opponent'], teams: [[], []] }, onExit);
    this.conn = conn;
    this.inbox = [];
    this.pumping = false;
    this.finished = false;
    this.teamsCache = [[], []];
    // Result-screen tuning. Tournament matches set autoExitMs so the view
    // returns to the arena bracket on its own (no manual "back" click needed)
    // and relabels the button accordingly.
    this.autoExitMs = 0;
    this.exitLabel = '← Back to Lab';
    this._autoExitTimer = null;
    // Quitting the screen should also drop the socket (server tells the foe).
    const rawExit = onExit;
    this.onExit = () => { this.finished = true; if (this._autoExitTimer) clearTimeout(this._autoExitTimer); try { this.conn.ws.close(); } catch { /* ignore */ } rawExit(); };
  }

  // No local engine in network mode.
  initBattle() { /* authoritative battle lives on the server */ }

  // Called by app.js right after the server's `matched` message.
  begin(matched) {
    this.mySide = matched.side;
    const abs = matched.names || ['You', 'Opponent'];
    // Store names in LOCAL order (index 0 = me) so inherited UI labels match.
    this.config.names = [abs[this.mySide], abs[1 - this.mySide]];
    this.conn.onMessage = (m) => this.onMessage(m);
    this.conn.onClose = () => this.onDisconnect();
    this.buildDom();
    this.say('Opponent found! Battle starting…', true);
  }

  localOf(absSide) { return absSide === this.mySide ? 0 : 1; }

  // ---- message pump (serializes async animation with incoming messages) ---
  onMessage(m) { this.inbox.push(m); this.pump(); }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.inbox.length) {
        const m = this.inbox.shift();
        await this.handle(m);
      }
    } finally {
      this.pumping = false;
    }
  }

  async handle(m) {
    switch (m.t) {
      case 'events': {
        // Cache team views in local order for the party indicators.
        this.teamsCache = [m.teams[this.mySide], m.teams[1 - this.mySide]];
        await this.playEvents(this.remap(m.events));
        return;
      }
      case 'request': {
        if (this.finished) return;
        const choice = await this.promptNet(m.request);
        if (this.finished) return;
        this.conn.send({ t: 'choice', choice });
        this.clearMenu();
        await this.say('Waiting for opponent…', true);
        return;
      }
      case 'waitOpp':
        this.clearMenu();
        await this.say('Waiting for opponent…', true);
        return;
      case 'end':
        this.finished = true;
        this.netResult = { winner: m.winner, turns: m.turns };
        this.showResultNet();
        return;
      case 'oppLeft':
        if (this.finished) return;
        this.finished = true;
        this.showLeaveResult('Your opponent left the battle.', 'You win by default!');
        return;
      case 'error':
        if (this.finished) return;
        this.finished = true;
        this.showLeaveResult('The battle ended unexpectedly.', m.msg || '');
        return;
      default:
        return;
    }
  }

  // Engine events carry absolute side indices; rewrite to local (0 = me) so the
  // inherited renderers draw my Pokémon at the bottom and the foe at the top.
  remap(events) {
    return events.map((e) => (e.side == null ? e : { ...e, side: this.localOf(e.side) }));
  }

  // Show the right menu for a server request and resolve with the chosen action.
  promptNet(request) {
    return new Promise((resolve) => {
      if (request.state === 'switch') {
        this.renderSwitchMenu(0, request, resolve, request.forceSwitch);
      } else if (request.forceMove) {
        this.say(`${request.active.name} is locked in!`, true);
        resolve({ type: 'move', forced: request.forceMove });
      } else {
        this.renderActionMenu(0, request, resolve);
      }
    });
  }

  // ---- overrides of battle-dependent helpers -----------------------------
  // Foe's active types come from the cached team view (no local engine here).
  defenderTypes() {
    const foe = this.teamsCache[1] || [];
    const active = foe.find((p) => p.active);
    return active ? active.types : null;
  }

  // Live party bar source. teamsCache is already in local order (index 0 = me).
  partyTeams() {
    return [this.teamsCache[0] || [], this.teamsCache[1] || []];
  }

  refreshParty(side) {
    const s = this.dom.slot[side];
    if (!s) return;
    s.party.innerHTML = '';
    const team = this.teamsCache[side] || [];
    for (const p of team) {
      const dot = document.createElement('div');
      dot.className = `dot${p.fainted ? ' fainted' : ''}`;
      s.party.append(dot);
    }
  }

  showResultNet() {
    const w = this.netResult.winner;
    const iWon = w === this.mySide;
    const title = w === 'tie' ? "It's a tie!" : (iWon ? 'You won!' : 'You lost…');
    const sub = `Battle ended in ${this.netResult.turns} turns.`;
    this.renderEndPanel(title, sub);
  }

  showLeaveResult(title, sub) { this.renderEndPanel(title, sub); }

  renderEndPanel(title, sub) {
    const panel = document.createElement('div');
    panel.className = 'panel result';
    const h = document.createElement('h2'); h.textContent = title;
    const d = document.createElement('div'); d.textContent = sub;
    const btns = document.createElement('div'); btns.className = 'btns';
    const back = document.createElement('button');
    back.className = 'primary'; back.textContent = this.exitLabel;
    back.addEventListener('click', () => this.onExit());
    btns.append(back);
    panel.append(h, d, btns);
    this.clearMenu();
    this.dom.menu.append(panel);
    this.dom.menu.className = 'menu';
    // Tournament matches dismiss themselves so the bracket can roll on.
    if (this.autoExitMs > 0) { this._autoExitTimer = setTimeout(() => this.onExit(), this.autoExitMs); }
  }

  onDisconnect() {
    if (this.finished) return;
    this.finished = true;
    this.showLeaveResult('Connection lost', 'Make sure the server is running, then try again.');
  }
}
