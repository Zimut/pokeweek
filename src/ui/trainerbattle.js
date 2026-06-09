// A trainer or gym battle: a normal single battle whose end reports an outcome
// ('won' | 'lost') back to the GameController instead of offering rematch/back.
// Reuses all of BattleView's rendering, input, and animation; only the result
// screen and the quit→forfeit behaviour change. Rewards, full-heal, badges and
// map-gating are applied by the controller from the reported outcome.
import { BattleView } from './battle.js';

const el = (tag, props = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of [].concat(kids)) if (c != null) n.append(c);
  return n;
};

export class TrainerBattleView extends BattleView {
  // opts: { onDone(result), winTitle, winSub, loseTitle, loseSub }
  constructor(dex, config, opts = {}) {
    super(dex, config, () => {});
    this.opts = opts;
    this.done = false;
  }

  // Header ✕ Quit: forfeit a running match (counts as a loss; the team is still
  // healed afterwards), or just leave once the result card is already showing.
  quit() {
    if (this.done) this.exit();
    else this.forfeit();
  }

  // Quitting mid-battle counts as a loss (the team is still healed afterwards).
  forfeit() { this.renderResult('lost', true); }

  // Called by the inherited loop() when the engine reaches 'end'.
  showResult() { this.renderResult(this.battle.winner === 0 ? 'won' : 'lost', false); }

  // Loop error/stall guard: end the encounter cleanly (no reward, team healed)
  // with a clear message + Continue button so the player is never frozen.
  bail() {
    if (this.done) { this.exit(); return; }
    this.done = true;
    this.result = { outcome: 'lost', forfeit: true };
    const panel = el('div', { class: 'panel result' }, [
      el('h2', { text: 'Battle interrupted' }),
      el('div', { text: 'Something went wrong — returning to the overworld. Your team was healed.' }),
      el('div', { class: 'btns' }, [el('button', { class: 'primary', text: '▶ Continue', onclick: () => this.exit() })]),
    ]);
    this.clearMenu();
    this.dom.menu.append(panel);
    this.dom.menu.className = 'menu';
  }

  renderResult(outcome, forfeit) {
    if (this.done) return;
    this.done = true;
    this.result = { outcome, forfeit };
    const title = outcome === 'won' ? (this.opts.winTitle || 'You won!') : (this.opts.loseTitle || 'You lost…');
    const sub = outcome === 'won' ? this.opts.winSub : this.opts.loseSub;
    const panel = el('div', { class: 'panel result' }, [
      el('h2', { text: title }),
      sub ? el('div', { text: sub }) : null,
      el('div', { class: 'btns' }, [
        el('button', { class: 'primary', text: '▶ Continue', onclick: () => this.exit() }),
      ]),
    ]);
    this.clearMenu();
    this.dom.menu.append(panel);
    this.dom.menu.className = 'menu';
  }

  // Single-fire hand-off to the controller — both the Continue button and the
  // header ✕ Quit route through here so onDone can't fire twice.
  exit() {
    if (this._exited) return;
    this._exited = true;
    if (this.opts.onDone) this.opts.onDone(this.result);
  }
}
