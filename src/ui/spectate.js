// Read-only battle renderer for the tournament arena (Task 19). A spectator
// never runs the engine and never sends input — the server streams the same
// event feed it sends the two combatants (in ABSOLUTE side order: 0 = the
// first-seeded player at the bottom, 1 = the second at the top). This reuses
// all of BattleView's rendering/animation and only overrides the few helpers
// that previously read a local `this.battle`.
import { BattleView } from './battle.js';

export class SpectateView extends BattleView {
  constructor(dex, onExit) {
    super(dex, { kind: 'spectate', controllers: ['net', 'net'], names: ['Player 1', 'Player 2'], teams: [[], []] }, onExit);
    this.finished = false;
    this.teamsCache = [[], []];
    this.inbox = [];
    this.pumping = false;
    this._autoClose = null;
    const rawExit = onExit;
    this.onExit = () => { if (this._autoClose) { clearTimeout(this._autoClose); this._autoClose = null; } rawExit(); };
  }

  // No local engine in spectate mode.
  initBattle() { /* authoritative battle lives on the server */ }

  // `first` is the opening spectate frame (sub: 'events' | 'end') or undefined.
  begin(first) {
    const names = (first && first.names) || ['Player 1', 'Player 2'];
    this.config.names = [names[0], names[1]];
    this.buildDom();
    this.say(`${names[0]} vs ${names[1]} — spectating…`, true);
    if (first) this.onFrame(first);
  }

  // ---- frame pump (serializes async animation with incoming frames) -------
  onFrame(m) { this.inbox.push(m); this.pump(); }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try { while (this.inbox.length) await this.handleFrame(this.inbox.shift()); }
    finally { this.pumping = false; }
  }

  async handleFrame(m) {
    if (m.sub === 'events') {
      if (m.names) this.config.names = [m.names[0], m.names[1]];
      this.teamsCache = [m.teams[0], m.teams[1]];
      await this.playEvents(m.events);   // absolute sides — no remap for a neutral viewer
    } else if (m.sub === 'end') {
      if (this.finished) return;
      this.finished = true;
      const w = m.winner;
      const names = this.config.names;
      const title = (w === 'tie' || w == null) ? "It's a draw!" : `${names[w] || 'A challenger'} wins!`;
      this.renderEndPanel(title, 'Returning to the bracket…');
      this._autoClose = setTimeout(() => this.onExit(), 2200);
    }
  }

  // ---- overrides of battle-dependent helpers -----------------------------
  defenderTypes() {
    const foe = this.teamsCache[1] || [];
    const active = foe.find((p) => p.active);
    return active ? active.types : null;
  }

  // Live party bar shows side 0's team (neutral viewer, absolute sides).
  partyTeams() {
    return [this.teamsCache[0] || [], this.teamsCache[1] || []];
  }

  refreshParty(side) {
    const s = this.dom.slot[side];
    if (!s) return;
    s.party.innerHTML = '';
    for (const p of (this.teamsCache[side] || [])) {
      const dot = document.createElement('div');
      dot.className = `dot${p.fainted ? ' fainted' : ''}`;
      s.party.append(dot);
    }
  }

  renderEndPanel(title, sub) {
    const panel = document.createElement('div');
    panel.className = 'panel result';
    const h = document.createElement('h2'); h.textContent = title;
    const d = document.createElement('div'); d.textContent = sub;
    const btns = document.createElement('div'); btns.className = 'btns';
    const back = document.createElement('button');
    back.className = 'primary'; back.textContent = '← Back to bracket';
    back.addEventListener('click', () => this.onExit());
    btns.append(back);
    panel.append(h, d, btns);
    this.clearMenu();
    this.dom.menu.append(panel);
    this.dom.menu.className = 'menu';
  }
}
