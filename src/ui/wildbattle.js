// A wild encounter: a normal single battle plus a "throw ball" action that can
// end it early by catching the foe. Reuses all of BattleView's rendering and
// animation; only the input loop and action menu change. Catch attempts are a
// "free" action (the wild Pokémon doesn't counter that turn) — the limited
// per-map ball supply is what keeps catching costly.
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

const BALL_NAME = { pokeball: 'Poké Ball', greatball: 'Great Ball' };

export class WildBattleView extends BattleView {
  constructor(dex, config, onExit, wild) {
    super(dex, config, onExit);
    this.wild = wild;       // { rarity, balls, catchChance, makeCaughtSet, onDone, ... }
    this.caughtSet = null;
  }

  // Loop error/stall guard: flee the encounter cleanly (no penalty).
  bail() { return this.finish('ran'); }

  // Custom loop so a ball throw can short-circuit the engine turn.
  async loop() {
    let stalls = 0;
    while (this.battle.state !== 'end') {
      try {
        // Forced switches (a side's active fainted) — defer to the base helper.
        if (this.battle.state === 'switch') {
          const before = this.battle.turn;
          for (let i = 0; i < 2; i++) {
            if (this.battle.needAction(i)) this.battle.choose(i, await this.chooseFor(i));
          }
          this.clearMenu();
          this.battle.go();
          const ev = this.battle.flushLog();
          await this.playEvents(ev);
          if (this.battle.turn === before && !ev.length && this.battle.state === 'switch') {
            if (++stalls >= 3) { console.error('[wild] stalled in switch'); await this.say('The battle stalled — returning…'); return this.finish('ran'); }
          } else stalls = 0;
          continue;
        }

        const action = await this.promptAction(0);
        if (action.type === 'run') {
          await this.say('Got away safely!', true);
          return this.finish('ran');
        }
        if (action.type === 'ball') {
          const caught = await this.tryCatch(action.ball);
          if (caught) return this.finish('caught');
          // A failed throw costs the player's turn: the wild Pokémon gets to act.
          this.battle.choose(0, { type: 'pass' });
          if (this.battle.needAction(1)) this.battle.choose(1, this.ai[1].decide());
          this.clearMenu();
          this.battle.go();
          await this.playEvents(this.battle.flushLog());
          stalls = 0;
          continue;
        }

        const before = this.battle.turn;
        this.battle.choose(0, action);
        if (this.battle.needAction(1)) this.battle.choose(1, this.ai[1].decide());
        this.clearMenu();
        this.battle.go();
        const ev = this.battle.flushLog();
        await this.playEvents(ev);
        // Watchdog: bail out gracefully if a turn advanced nothing (no spin/hang).
        if (this.battle.turn === before && !ev.length) {
          if (++stalls >= 3) { console.error('[wild] stalled — no progress'); await this.say('The battle stalled — returning…'); return this.finish('ran'); }
        } else stalls = 0;
      } catch (err) {
        // Never silently freeze: log, then exit the encounter safely (no penalty).
        console.error('[wild battle] turn failed to resolve:', err);
        try { await this.say('The battle hit a snag — returning…'); } catch { /* ignore */ }
        return this.finish('ran');
      }
    }
    this.finish(this.battle.winner === 0 ? 'defeated' : 'lost');
  }

  // Wild action menu: FIGHT / POKéMON / BALL / RUN. (Overrides BattleView so
  // the inherited move/switch "Back" buttons return here too.)
  renderActionMenu(side, req, resolve) {
    this.say(`What will ${req.active.name} do?`, true);
    const menu = this.dom.menu;
    menu.className = 'menu actions';
    menu.innerHTML = '';
    const canCatch = this.wild.canCatch !== false; // gated by this route's encounters
    menu.append(
      el('button', { class: 'primary', text: '⚔ FIGHT', onclick: () => this.renderMoveMenu(side, req, resolve) }),
      el('button', { class: 'secondary', text: '🔁 POKéMON', disabled: !req.active.canSwitch, onclick: () => this.renderSwitchMenu(side, req, resolve, false) }),
      el('button', {
        class: 'ghost', text: '🎯 BALL', disabled: !canCatch,
        title: canCatch ? '' : "You're out of catchable encounters on this route.",
        onclick: () => { if (canCatch) this.renderBallMenu(side, req, resolve); },
      }),
      el('button', { class: 'ghost', text: '🏃 RUN', onclick: () => { this.clearMenu(); resolve({ type: 'run' }); } }),
    );
  }

  renderBallMenu(side, req, resolve) {
    const menu = this.dom.menu;
    menu.className = 'menu';
    menu.innerHTML = '';
    for (const ball of ['pokeball', 'greatball']) {
      const n = this.wild.balls[ball];
      const count = n === Infinity ? '∞' : n;
      menu.append(el('button', {
        class: 'ballbtn',
        disabled: n !== Infinity && n <= 0,
        onclick: () => { this.clearMenu(); resolve({ type: 'ball', ball }); },
      }, [
        el('span', { class: `ball-ico ball-${ball}` }),
        el('span', { class: 'ball-name', text: BALL_NAME[ball] }),
        el('span', { class: 'ball-count', text: `×${count}` }),
      ]));
    }
    menu.append(el('button', { class: 'ghost back', text: '◀ Back', onclick: () => this.renderActionMenu(side, req, resolve) }));
  }

  // Throw a ball; returns true on a successful catch.
  async tryCatch(ball) {
    const balls = this.wild.balls;
    if (balls[ball] !== Infinity && balls[ball] <= 0) {
      await this.say(`You're out of ${BALL_NAME[ball]}s!`, true);
      return false;
    }
    if (balls[ball] !== Infinity) balls[ball]--;

    const foe = this.battle.teamView(this.battle.sides[1]).find((p) => p.active);
    const chance = this.wild.catchChance(foe.hpPct, foe.status, ball);

    await this.say(`You used one ${BALL_NAME[ball]}!`, true);
    const sprite = this.dom.slot[1].sprite;
    await this.ballAnim(sprite);

    const caught = Math.random() < chance;
    // Number of wobbles before the result (cosmetic): more for closer calls.
    const wobbles = caught ? 3 : Math.min(3, Math.floor((Math.random() * 0.6 + chance) * 4));
    for (let i = 0; i < wobbles; i++) { await this.wobble(sprite); }

    if (caught) {
      sprite.classList.add('caught');
      await this.say(`Gotcha! ${foe.name} was caught!`, true);
      await this.sleep(500);
      this.caughtSet = this.wild.makeCaughtSet();
      return true;
    }
    sprite.classList.remove('inball');
    await this.say('Oh no! The Pokémon broke free!', true);
    return false;
  }

  ballAnim(sprite) {
    return new Promise((resolve) => {
      sprite.classList.add('inball');
      setTimeout(resolve, 420 / this.speed);
    });
  }

  wobble(sprite) {
    return new Promise((resolve) => {
      sprite.classList.remove('wobble'); void sprite.offsetWidth; sprite.classList.add('wobble');
      setTimeout(() => { sprite.classList.remove('wobble'); resolve(); }, 360 / this.speed);
    });
  }

  // Resolve the encounter and show a small end card before returning.
  finish(outcome) {
    this.result = { outcome, caughtSet: this.caughtSet };
    const titles = {
      caught: 'Pokémon caught!', defeated: 'The wild Pokémon fainted!',
      ran: 'Got away safely', lost: 'You have no Pokémon left!',
    };
    const subs = {
      caught: this.caughtSet ? `${this.dex.getSpecies(this.caughtSet.species).name} joined you.` : '',
      defeated: 'Your team was fully healed.',
      ran: '', lost: 'Your team was fully healed.',
    };
    const panel = el('div', { class: 'panel result' }, [
      el('h2', { text: titles[outcome] || 'Encounter over' }),
      subs[outcome] ? el('div', { text: subs[outcome] }) : null,
      el('div', { class: 'btns' }, [
        el('button', { class: 'primary', text: '▶ Continue', onclick: () => this.exit() }),
      ]),
    ]);
    this.clearMenu();
    this.dom.menu.append(panel);
    this.dom.menu.className = 'menu';
  }

  // Single-fire return to the overworld — used by both the Continue button and
  // the header ✕ Quit so neither can double-fire onDone (which would re-add a
  // caught Pokémon or re-resolve the promise).
  exit() {
    if (this._exited) return;
    this._exited = true;
    this.wild.onDone(this.result);
  }

  // Header ✕ Quit: abandon a still-running encounter (treated as running away),
  // or just leave once a result card is already showing.
  quit() {
    if (!this.result) this.result = { outcome: 'ran', caughtSet: null };
    this.exit();
  }
}
