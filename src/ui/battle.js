// Renders a live battle from the engine and drives it: gathers human input via
// on-screen menus, asks the engine AI for computer sides, and animates the
// resulting event stream (HP bars, sprite flashes, typewriter message log).
import { Battle } from '../engine/battle.js';
import { AI } from '../engine/ai.js';
import { spriteFront, spriteBack, STATUS_SHORT, TYPE_COLORS } from './data.js';
import { moveDescription, effectivenessInfo } from './movedesc.js';

const el = (tag, props = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of [].concat(kids)) if (c != null) n.append(c);
  return n;
};

// Battle speed is a per-player preference (1x / 2x / 4x) kept in localStorage so
// it persists forever across battles, lobbies and reloads — set it once and it
// sticks. Shared by every battle view (all extend BattleView).
const SPEED_KEY = 'pokeweek:battleSpeed';
const SPEED_CYCLE = [1, 2, 4];
function loadBattleSpeed() {
  try { const v = Number(localStorage.getItem(SPEED_KEY)); return SPEED_CYCLE.includes(v) ? v : 1; } catch { return 1; }
}
function saveBattleSpeed(v) { try { localStorage.setItem(SPEED_KEY, String(v)); } catch { /* ignore */ } }

export class BattleView {
  constructor(dex, config, onExit) {
    this.dex = dex;
    this.config = config; // { kind, controllers, names, teams }
    this.onExit = onExit;
    this.speed = loadBattleSpeed(); // remembered player preference (1x/2x/4x)
    this.root = el('div', { class: 'battle-wrap' });
    this.initBattle();
  }

  initBattle() {
    this.battle = new Battle({
      dex: this.dex,
      seed: (Math.random() * 2 ** 31) | 0,
      kind: this.config.kind,
      sides: [
        { team: this.config.teams[0], name: this.config.names[0] },
        { team: this.config.teams[1], name: this.config.names[1] },
      ],
    });
    this.ai = [new AI(this.battle, 0), new AI(this.battle, 1)];
  }

  sleep(ms) { return new Promise((r) => setTimeout(r, ms / this.speed)); }

  // ---- DOM scaffold ------------------------------------------------------
  buildDom() {
    this.root.innerHTML = '';

    // header (turn / speed / quit)
    this.dom = {};
    this.dom.turn = el('span', { class: 'turn-indicator', text: 'Turn 1' });
    const speedBtn = el('button', { class: 'ghost', text: `Speed: ${this.speed}x` });
    speedBtn.addEventListener('click', () => {
      this.speed = this.speed === 1 ? 2 : this.speed === 2 ? 4 : 1;
      speedBtn.textContent = `Speed: ${this.speed}x`;
      saveBattleSpeed(this.speed); // persist the preference forever
    });
    const quitBtn = el('button', { class: 'ghost', text: '✕ Quit', onclick: () => this.quit() });
    const header = el('div', { style: 'width:min(860px,96vw);display:flex;align-items:center;gap:10px' }, [
      this.dom.turn, el('span', { style: 'flex:1' }), speedBtn, quitBtn,
    ]);

    // battlefield
    this.dom.battle = el('div', { class: 'battle' });
    this.dom.slot = [this.makeSlot(0), this.makeSlot(1)];
    this.dom.battle.append(this.dom.slot[1].wrap, this.dom.slot[0].wrap);

    // control deck
    this.dom.msg = el('div', { class: 'msgbox' });
    this.dom.menu = el('div', { class: 'menu' });
    const deck = el('div', { class: 'deck' }, [this.dom.msg, this.dom.menu]);

    this.root.append(header, this.dom.battle, deck);
  }

  makeSlot(side) {
    const isFoe = side === 1;
    const sprite = el('img', { class: 'sprite', alt: '' });
    const name = el('span', { class: 'ic-name' });
    const lv = el('span', { class: 'ic-lv' });
    const status = el('span', { class: 'ic-status' });
    const hpfill = el('div', { class: 'fill' });
    const hptext = el('div', { class: 'hptext' });
    const party = el('div', { class: 'party' });

    const card = el('div', { class: 'infocard' }, [
      el('div', { class: 'ic-top' }, [name, status, lv]),
      el('div', { class: 'hpbar-wrap' }, [el('span', { class: 'lbl', text: 'HP' }), el('div', { class: 'hpbar' }, hpfill)]),
      isFoe ? party : hptext,
      isFoe ? null : party,
    ]);
    const wrap = el('div', { class: `field-slot ${isFoe ? 'foe' : 'ally'}` }, [
      el('div', { class: 'platform' }), sprite, card,
    ]);
    return { wrap, sprite, name, lv, status, hpfill, hptext, party, isFoe };
  }

  // ---- run / restart -----------------------------------------------------
  async run() {
    this.buildDom();
    this.battle.start();
    await this.playEvents(this.battle.flushLog());
    await this.loop();
  }

  async restart() {
    this.initBattle();
    this.buildDom();
    this.battle.start();
    await this.playEvents(this.battle.flushLog());
    await this.loop();
  }

  // Header ✕ Quit. Subclasses override to forfeit (trainer/gym), abandon the
  // encounter (wild), or just leave a finished result screen. The base view
  // (test lab / network) simply exits.
  quit() { this.onExit(); }

  async loop() {
    let stalls = 0;
    while (this.battle.state !== 'end') {
      try {
        const beforeTurn = this.battle.turn;
        for (let i = 0; i < 2; i++) {
          if (this.battle.needAction(i)) {
            const choice = await this.chooseFor(i);
            this.battle.choose(i, choice);
          }
        }
        this.clearMenu();
        this.battle.go();
        const events = this.battle.flushLog();
        await this.playEvents(events);
        // Watchdog: a completed iteration that advanced neither the turn counter
        // nor produced any events means the state machine is stuck — bail out
        // gracefully after a few tries instead of spinning forever.
        if (this.battle.turn === beforeTurn && !events.length) {
          if (++stalls >= 3) { console.error('[battle] stalled — no progress'); await this.say('The battle stalled — returning…'); return this.bail(); }
        } else stalls = 0;
      } catch (err) {
        // Never silently hang: surface the error and stop the turn loop.
        console.error('[battle] turn failed to resolve:', (err && err.stack) || err);
        try { await this.say('The battle hit a snag — returning…'); } catch { /* ignore */ }
        return this.bail();
      }
    }
    this.showResult();
  }

  // Safe abort used by the loop's error/stall guards. The base view just calls
  // onExit; trainer/gym and wild views override this so a snag returns the player
  // to the overworld instead of freezing on the message (onExit is a no-op there).
  bail() { try { return this.onExit(); } catch (e) { console.error('[battle] bail failed:', (e && e.stack) || e); } }

  chooseFor(side) {
    if (this.config.controllers[side] === 'ai') return Promise.resolve(this.ai[side].decide());
    if (this.battle.state === 'switch') return this.promptSwitch(side, true);
    return this.promptAction(side);
  }

  // ---- human input -------------------------------------------------------
  promptAction(side) {
    return new Promise((resolve) => {
      const req = this.battle.getRequest(side);
      if (req.forceMove) { // locked into a charging/thrashing move
        this.say(`${req.active.name} is locked in!`);
        resolve({ type: 'move', forced: req.forceMove });
        return;
      }
      this.renderActionMenu(side, req, resolve);
    });
  }

  renderActionMenu(side, req, resolve) {
    const who = this.config.controllers.filter((c) => c === 'human').length > 1 ? `${this.config.names[side]} — ` : '';
    this.say(`${who}What will ${req.active.name} do?`, true);
    const menu = this.dom.menu;
    menu.className = 'menu actions';
    menu.innerHTML = '';
    menu.append(
      el('button', { class: 'primary', text: '⚔ FIGHT', onclick: () => this.renderMoveMenu(side, req, resolve) }),
      el('button', { class: 'secondary', text: '🔁 POKéMON', disabled: !req.active.canSwitch, onclick: () => this.renderSwitchMenu(side, req, resolve, false) }),
    );
    if (this.config.kind === 'wild' && side === 0) {
      menu.append(el('button', { class: 'ghost', text: '🏃 RUN', onclick: () => { this.say('Got away safely!'); setTimeout(() => this.onExit(), 600); } }));
    } else {
      menu.append(el('button', { class: 'ghost', text: '— ', disabled: true }));
    }
  }

  renderMoveMenu(side, req, resolve) {
    const menu = this.dom.menu;
    menu.className = 'menu moves';
    menu.innerHTML = '';
    // The message box currently shows "What will X do?"; remember it so we can
    // restore it when the pointer leaves a move (the tooltip borrows that box).
    const prompt = (this.dom.msg.textContent || '').replace(/▋$/, '');
    const restore = () => { this.dom.msg.textContent = prompt; };
    const foeTypes = this.defenderTypes(side);

    for (const m of req.active.moves) {
      const color = TYPE_COLORS[m.type] || '#888';
      const full = this.dex.getMove(m.id);
      const eff = effectivenessInfo(full, m.type, this.dex, foeTypes);

      const name = el('span', { class: 'mv-name', text: m.name });
      if (eff) name.classList.add(eff.cls);
      const nameLine = el('span', { class: 'mv-nameline' }, [
        name, eff ? el('span', { class: `mv-eff ${eff.cls}`, text: eff.badge }) : null,
      ]);

      const btn = el('button', {
        class: 'movebtn',
        disabled: m.disabled,
        style: `border-left:8px solid ${color}`,
        onclick: () => { this.clearMenu(); resolve({ type: 'move', move: m.index }); },
        onmouseenter: () => this.showMoveTip(m, full, eff),
        onmouseleave: restore,
        onfocus: () => this.showMoveTip(m, full, eff),
        onblur: restore,
      }, [
        nameLine,
        el('span', { class: 'mv-info' }, [
          el('span', { class: 'typechip', text: m.type, style: `background:${color}` }),
          el('span', { text: m.category }),
          el('span', { class: 'mv-pp', text: `PP ${m.pp}/${m.maxpp}` }),
        ]),
      ]);
      menu.append(btn);
    }
    // If there are no moves at all, or every move is unusable (all disabled / out
    // of PP), offer Struggle so the player is never stuck with no selectable
    // action (the engine resolves an out-of-range/empty choice to Struggle).
    if (!req.active.moves.length || req.active.moves.every((m) => m.disabled)) {
      const idx = req.active.moves.length ? req.active.moves[0].index : 0;
      menu.append(el('button', { class: 'movebtn', style: 'border-left:8px solid #888', onclick: () => { this.clearMenu(); resolve({ type: 'move', move: idx }); } },
        [el('span', { class: 'mv-nameline' }, [el('span', { class: 'mv-name', text: 'Struggle' })]), el('span', { class: 'mv-info' }, [el('span', { text: 'No usable moves' })])]));
    }
    menu.append(el('button', { class: 'ghost back', text: '◀ Back', onclick: () => { restore(); this.renderActionMenu(side, req, resolve); } }));
  }

  // Types of the opposing side's active Pokémon (for the effectiveness cue).
  // Overridden in NetworkBattleView, which has no local engine.
  defenderTypes(attackerSide) {
    if (!this.battle) return null;
    const foe = this.battle.teamView(this.battle.sides[1 - attackerSide]);
    const active = foe.find((p) => p.active);
    return active ? active.types : null;
  }

  // Render a move's full info into the message box, under the action prompt.
  showMoveTip(m, full, eff) {
    const color = TYPE_COLORS[m.type] || '#888';
    const power = full.basePower && full.basePower > 0 ? String(full.basePower) : '—';
    const acc = (full.accuracy === true || full.accuracy == null) ? '—' : `${full.accuracy}%`;
    const tip = el('div', { class: 'movetip' }, [
      el('div', { class: 'mt-head' }, [
        el('span', { class: 'mt-name', text: m.name }),
        el('span', { class: 'typechip', text: m.type, style: `background:${color}` }),
        el('span', { class: 'mt-cat', text: m.category }),
        eff ? el('span', { class: `mt-eff ${eff.cls}`, text: eff.tip }) : null,
      ]),
      el('div', { class: 'mt-stats' }, [
        el('span', { html: `<b>Power</b> ${power}` }),
        el('span', { html: `<b>Acc</b> ${acc}` }),
        el('span', { html: `<b>PP</b> ${m.pp}/${m.maxpp}` }),
      ]),
      el('div', { class: 'mt-desc', text: moveDescription(full) }),
    ]);
    this.dom.msg.textContent = '';
    this.dom.msg.append(tip);
  }

  renderSwitchMenu(side, req, resolve, forced) {
    const menu = this.dom.menu;
    menu.className = 'menu';
    menu.innerHTML = '';
    for (const p of req.team) {
      if (p.active || p.fainted) continue;
      const color = TYPE_COLORS[p.types[0]] || '#888';
      const pct = Math.round(p.hpPct * 100);
      const btn = el('button', {
        class: 'switchbtn',
        style: `border-left:8px solid ${color}`,
        onclick: () => { this.clearMenu(); resolve({ type: 'switch', target: p.index }); },
      }, [
        el('img', { src: spriteFront(p.num) }),
        el('div', { class: 'sw-meta' }, [
          el('span', { text: `${p.name}  Lv${p.level}`, style: 'font-size:12px;font-weight:800' }),
          el('div', { class: 'mini-hp' }, el('div', { class: 'f', style: `width:${pct}%` })),
        ]),
      ]);
      menu.append(btn);
    }
    if (!forced) menu.append(el('button', { class: 'ghost back', text: '◀ Back', onclick: () => this.renderActionMenu(side, req, resolve) }));
    else this.say(`${this.config.names[side]}: choose your next Pokémon.`, true);
  }

  promptSwitch(side, forced) {
    return new Promise((resolve) => {
      const req = this.battle.getRequest(side);
      this.renderSwitchMenu(side, req, resolve, forced);
    });
  }

  clearMenu() { if (this.dom.menu) { this.dom.menu.innerHTML = ''; this.dom.menu.className = 'menu'; } }

  // ---- event animation ---------------------------------------------------
  async playEvents(events) { for (const e of events) await this.playEvent(e); }

  async playEvent(e) {
    switch (e.type) {
      case 'turn': this.dom.turn.textContent = `Turn ${e.n}`; return;
      case 'switchIn': await this.onSwitchIn(e); if (e.text) await this.say(e.text); return;
      case 'move': if (e.text) await this.say(e.text); await this.onMove(e); return;
      case 'damage': await this.onDamage(e); return;
      case 'heal': this.setHp(e.side, e.hpPct, e.hp, e.maxhp); if (e.text) await this.say(e.text); else await this.sleep(420); return;
      case 'faint': await this.onFaint(e); if (e.text) await this.say(e.text); return;
      case 'status': this.updateStatus(e.side, e.status); break;
      case 'curestatus': this.updateStatus(e.side, null); break;
      case 'weather': this.setWeatherClass(e.weather); break;
      default: break;
    }
    if (e.text) await this.say(e.text);
  }

  async onSwitchIn(e) {
    const s = this.dom.slot[e.side];
    this.refreshParty(e.side);
    s.sprite.src = e.side === 0 ? spriteBack(e.num) : spriteFront(e.num);
    s.sprite.classList.remove('faint');
    s.name.textContent = e.name;
    s.lv.textContent = `Lv${e.level}`;
    this.updateStatus(e.side, e.status);
    this.setHp(e.side, e.hpPct, e.hp, e.maxhp, true);
    // retrigger enter animation
    const cls = e.side === 0 ? 'enter-ally' : 'enter-foe';
    s.sprite.classList.remove(cls); void s.sprite.offsetWidth; s.sprite.classList.add(cls);
    await this.sleep(360);
  }

  async onDamage(e) {
    const s = this.dom.slot[e.side];
    s.sprite.classList.remove('hurt'); void s.sprite.offsetWidth; s.sprite.classList.add('hurt');
    if (e.dmg > 0) this.floatDamage(e.side, e.dmg, e.crit);
    this.setHp(e.side, e.hpPct, e.hp, e.maxhp);
    await this.sleep(580);
  }

  async onFaint(e) {
    const s = this.dom.slot[e.side];
    s.sprite.classList.add('faint');
    this.refreshParty(e.side, e.side);
    await this.sleep(520);
  }

  // Attack flourish, played right after the "X used Y!" line and before the
  // defender's hit reaction: physical moves lunge the attacker forward; special
  // moves hurl a type-coloured orb across the field; status moves give the user
  // a brief glow. Animation durations are scaled by battle speed so they always
  // finish within the awaited delay.
  async onMove(e) {
    const s = this.dom.slot[e.side];
    if (!s || !s.sprite) return;
    const cat = String(e.category || '').toLowerCase();
    const color = TYPE_COLORS[e.moveType] || '#e8e8e8';
    if (cat === 'special') {
      await this.fireProjectile(e.side, color);
      return;
    }
    const dur = cat === 'physical' ? 0.42 : 0.5;
    const cls = cat === 'physical' ? (e.side === 0 ? 'lunge-ally' : 'lunge-foe') : 'cast';
    s.sprite.style.animationDuration = `${dur / this.speed}s`;
    s.sprite.classList.remove(cls); void s.sprite.offsetWidth; s.sprite.classList.add(cls);
    await this.sleep(dur * 1000);
    s.sprite.classList.remove(cls);
    s.sprite.style.animationDuration = '';
  }

  // Launch a glowing orb from the attacker's sprite to the defender's, coloured
  // by the move's type. Positions are measured live so it works at any size.
  async fireProjectile(side, color) {
    const from = this.dom.slot[side] && this.dom.slot[side].sprite;
    const to = this.dom.slot[1 - side] && this.dom.slot[1 - side].sprite;
    const field = this.dom.battle;
    if (!from || !to || !field) { await this.sleep(420); return; }
    const br = field.getBoundingClientRect();
    const fr = from.getBoundingClientRect();
    const tr = to.getBoundingClientRect();
    const x0 = fr.left + fr.width / 2 - br.left;
    const y0 = fr.top + fr.height / 2 - br.top;
    const x1 = tr.left + tr.width / 2 - br.left;
    const y1 = tr.top + tr.height / 2 - br.top;
    const orb = el('div', { class: 'proj' });
    orb.style.left = `${x0}px`;
    orb.style.top = `${y0}px`;
    orb.style.setProperty('--col', color);
    orb.style.setProperty('--dx', `${x1 - x0}px`);
    orb.style.setProperty('--dy', `${y1 - y0}px`);
    orb.style.animationDuration = `${0.46 / this.speed}s`;
    field.append(orb);
    await this.sleep(460);
    orb.remove();
  }

  // ---- view-model updates ------------------------------------------------
  setHp(side, pct, hp, maxhp, instant = false) {
    const s = this.dom.slot[side];
    if (instant) s.hpfill.style.transition = 'none';
    s.hpfill.style.width = `${Math.max(0, Math.min(100, pct * 100))}%`;
    s.hpfill.classList.toggle('mid', pct <= 0.5 && pct > 0.2);
    s.hpfill.classList.toggle('low', pct <= 0.2);
    if (!s.isFoe && hp != null) s.hptext.textContent = `${hp}/${maxhp}`;
    if (instant) { void s.hpfill.offsetWidth; s.hpfill.style.transition = ''; }
  }

  updateStatus(side, status) {
    const s = this.dom.slot[side];
    if (!s || !s.status) return; // missing/unknown side — never throw out of the turn loop
    if (!status) { s.status.className = 'ic-status'; s.status.textContent = ''; return; }
    s.status.className = `ic-status show st-${status}`;
    s.status.textContent = STATUS_SHORT[status] || status.toUpperCase();
  }

  refreshParty(side) {
    const s = this.dom.slot[side];
    s.party.innerHTML = '';
    const team = this.battle.teamView(this.battle.sides[side]);
    for (const p of team) s.party.append(el('div', { class: `dot${p.fainted ? ' fainted' : ''}` }));
  }

  setWeatherClass(weather) {
    this.dom.battle.className = 'battle' + (weather ? ` weather-${weather}` : '');
  }

  floatDamage(side, dmg, crit) {
    const pos = side === 1 ? 'top:22%;right:22%' : 'bottom:30%;left:20%';
    const f = el('div', { class: `dmgfloat${crit ? ' crit' : ''}`, text: `-${dmg}`, style: pos });
    this.dom.battle.append(f);
    setTimeout(() => f.remove(), 1000 / this.speed);
  }

  // ---- message box typewriter -------------------------------------------
  async say(text, noHold = false) {
    const box = this.dom.msg;
    box.textContent = '';
    const cursor = el('span', { class: 'cursor', text: '▋' });
    for (let i = 0; i < text.length; i++) {
      box.textContent = text.slice(0, i + 1);
      box.append(cursor);
      await this.sleep(16);
    }
    box.textContent = text;
    if (!noHold) await this.sleep(520);
  }

  // ---- result ------------------------------------------------------------
  showResult() {
    const w = this.battle.winner;
    const title = w === 'tie' ? "It's a tie!" : `${this.config.names[w]} won!`;
    const sub = this.config.kind === 'wild' && w === 0 ? 'The wild Pokémon was defeated!'
      : `Battle ended in ${this.battle.turn} turns.`;
    const panel = el('div', { class: 'panel result' }, [
      el('h2', { text: title }),
      el('div', { text: sub }),
      el('div', { class: 'btns' }, [
        el('button', { class: 'primary', text: '⟳ Rematch', onclick: () => this.restart() }),
        el('button', { class: 'secondary', text: '← Back to Lab', onclick: () => this.onExit() }),
      ]),
    ]);
    this.clearMenu();
    this.dom.menu.append(panel);
    this.dom.menu.className = 'menu';
  }
}
