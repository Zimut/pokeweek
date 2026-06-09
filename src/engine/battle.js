import { RNG } from './rng.js';
import { Side } from './pokemon.js';
import { calcDamage, moveType, moveCategoryFromType, effectivenessOf, effLabel } from './damage.js';
import { critChance, accStageMultiplier, STAT_NAMES, STATUS } from './constants.js';
import { hiddenPower } from './stats.js';

const STRUGGLE = {
  id: 'struggle', name: 'Struggle', type: 'Normal', category: 'Physical',
  basePower: 50, accuracy: true, pp: 1, priority: 0, flags: { contact: 1 },
  recoil: [1, 4], // Gen 2: user takes 1/4 of the damage dealt as recoil.
};

// Moves that take a turn to charge before striking.
const CHARGE_MOVES = {
  solarbeam: { msg: 'took in sunlight!' },
  skyattack: { msg: 'is glowing!' },
  razorwind: { msg: 'made a whirlwind!' },
  skullbash: { msg: 'lowered its head!', boostSelf: { def: 1 } },
  fly: { msg: 'flew up high!', invuln: true },
  dig: { msg: 'dug a hole!', invuln: true },
};
// Which moves can strike a semi-invulnerable target.
const HITS_INVULN = {
  dig: new Set(['earthquake', 'magnitude', 'fissure']),
  fly: new Set(['gust', 'thunder', 'twister', 'whirlwind']),
};
const RECHARGE_MOVES = new Set(['hyperbeam']);
const LOCKING_MOVES = { thrash: [2, 3], petaldance: [2, 3], outrage: [2, 3] };
const BINDING_MOVES = new Set(['wrap', 'bind', 'firespin', 'clamp', 'whirlpool']);
// Volatiles stored as objects (with turns/owner data) and read by dedicated
// code paths. They must never be created as a bare boolean by the generic
// volatile applier, or end-of-turn bookkeeping will dereference undefined.
const STRUCTURED_VOLATILES = new Set([
  'disable', 'encore', 'perishsong', 'confusion', 'leechseed', 'partiallytrapped',
  'lockedMove', 'twoturn', 'substitute', 'destinybond',
]);
// Moves that deal damage despite having basePower 0 in the data (their damage
// is computed by a special formula), so they must use the damaging path.
const DAMAGING_ZERO_POWER = new Set([
  'seismictoss', 'nightshade', 'dragonrage', 'sonicboom', 'psywave', 'superfang',
  'fissure', 'horndrill', 'guillotine', 'flail', 'reversal', 'magnitude',
  'return', 'frustration', 'present', 'hiddenpower',
]);

export class Battle {
  constructor(opts) {
    this.dex = opts.dex;
    this.rng = new RNG(opts.seed);
    this.format = opts.format || 'singles';
    const s0 = opts.sides[0];
    const s1 = opts.sides[1];
    this.sides = [new Side(s0.team, this.dex, s0.name || 'Player'), new Side(s1.team, this.dex, s1.name || 'Opponent')];
    this.sides[0].prefix = s0.prefix ?? '';
    this.sides[1].prefix = s1.prefix ?? (opts.kind === 'wild' ? 'Wild ' : 'Foe ');
    this.sides[0].isPlayer = true;
    this.kind = opts.kind || 'trainer'; // 'wild' | 'trainer' | 'pvp'
    this.field = { weather: null, weatherTurns: 0 };
    this.turn = 0;
    this.state = 'choice';
    this.choices = [null, null];
    this.needSwitch = [false, false];
    this.winner = null;
    this.log = [];
    this.ended = false;
  }

  // ---- event log helpers -------------------------------------------------
  add(ev) { this.log.push(ev); }
  flushLog() { const l = this.log; this.log = []; return l; }

  sideOf(pokemon) { return this.sides[0].team.includes(pokemon) ? this.sides[0] : this.sides[1]; }
  sideIndexOf(pokemon) { return this.sides[0].team.includes(pokemon) ? 0 : 1; }
  opponentSide(side) { return this.sides[this.sides.indexOf(side) === 0 ? 1 : 0]; }
  foeOf(pokemon) { return this.opponentSide(this.sideOf(pokemon)).active; }
  nameOf(pokemon) { return this.sideOf(pokemon).prefix + pokemon.name; }

  // ---- start -------------------------------------------------------------
  start() {
    this.add({ type: 'start', text: 'Battle start!' });
    for (let i = 1; i >= 0; i--) this.sendOut(i, this.sides[i].activeIndex, true);
    this.state = 'choice';
    this.makeRequest();
  }

  sendOut(sideIndex, teamIndex, initial = false) {
    const side = this.sides[sideIndex];
    side.activeIndex = teamIndex;
    const p = side.active;
    p.participated = true; // sent into battle → eligible for full battle EXP
    p.justSwitchedIn = true;
    p.onSwitchOut(); // reset boosts/volatiles when freshly out
    p.fainted = p.hp <= 0;
    let text;
    if (sideIndex === 0) text = initial ? `Go! ${p.name}!` : `Go! ${p.name}!`;
    else text = this.kind === 'wild' ? `Wild ${p.name} appeared!` : `${side.name} sent out ${p.name}!`;
    this.add({
      type: 'switchIn', side: sideIndex, name: p.name, num: p.num, level: p.level, shiny: !!p.shiny,
      hp: p.hp, maxhp: p.maxhp, hpPct: p.hpPercent(), status: p.status, gender: p.gender, text,
    });
    // Spikes (Gen 2) on entry.
    if (side.conditions.spikes && !p.hasType('Flying')) {
      const dmg = Math.floor(p.maxhp / 8);
      this.applyDamage(p, dmg, { cause: 'spikes' });
      this.add({ type: 'msg', text: `${this.nameOf(p)} is hurt by spikes!` });
    }
  }

  // ---- request / choice handling ----------------------------------------
  makeRequest() {
    if (this.ended) { this.state = 'end'; return; }
    if (this.needSwitch[0] || this.needSwitch[1]) { this.state = 'switch'; return; }
    this.state = 'choice';
  }

  // Action a side must take right now: 'move', 'switch', or null.
  needAction(sideIndex) {
    if (this.state === 'end') return null;
    if (this.state === 'switch') return this.needSwitch[sideIndex] ? 'switch' : null;
    return 'choice';
  }

  // Describe the choice options for a side (for UI / AI).
  getRequest(sideIndex) {
    const side = this.sides[sideIndex];
    const p = side.active;
    if (this.state === 'switch') {
      return { state: 'switch', forceSwitch: this.needSwitch[sideIndex], team: this.teamView(side) };
    }
    const locked = p.volatiles.twoturn || p.volatiles.lockedMove;
    const moves = p.moveSlots.map((m, i) => ({
      index: i, id: m.id, name: m.move.name, type: moveType(m.move, p),
      category: m.move.category, pp: m.pp, maxpp: m.maxpp,
      disabled: m.pp <= 0 || (p.volatiles.disable && p.volatiles.disable.moveId === m.id) ||
        (locked && locked.moveId !== m.id),
    }));
    const trapped = !!p.volatiles.partiallytrapped || !!p.volatiles.meanlook || !!locked;
    return {
      state: 'choice', forceMove: locked ? locked.moveId : null,
      active: { name: p.name, moves, canSwitch: !trapped && side.switchableIndices().length > 0 },
      team: this.teamView(side),
    };
  }

  teamView(side) {
    return side.team.map((p, i) => ({
      index: i, name: p.name, num: p.num, level: p.level, hp: p.hp, maxhp: p.maxhp,
      hpPct: p.hpPercent(), status: p.status, fainted: p.isFainted(), active: i === side.activeIndex,
      types: p.types, shiny: !!p.shiny,
    }));
  }

  choose(sideIndex, choice) {
    this.choices[sideIndex] = choice;
  }

  // Advance the state machine as far as possible given stored choices.
  go() {
    if (this.state === 'end') return;
    if (this.state === 'choice') {
      // Auto-fill a forced move/charge if a side did not actively choose.
      for (let i = 0; i < 2; i++) {
        const p = this.sides[i].active;
        const locked = p.volatiles.twoturn || p.volatiles.lockedMove;
        if (!this.choices[i] && locked) this.choices[i] = { type: 'move', forced: locked.moveId };
      }
      if (this.choices[0] && this.choices[1]) {
        this.runTurn(this.choices[0], this.choices[1]);
        this.choices = [null, null];
        this.afterTurn();
      }
    } else if (this.state === 'switch') {
      for (let i = 0; i < 2; i++) {
        if (this.needSwitch[i] && this.choices[i] && this.choices[i].type === 'switch') {
          this.sendOut(i, this.choices[i].target);
          this.needSwitch[i] = false;
          this.choices[i] = null;
        }
      }
      if (!this.needSwitch[0] && !this.needSwitch[1]) this.makeRequest();
    }
  }

  // ---- turn execution ----------------------------------------------------
  runTurn(a0, a1) {
    this.turn++;
    this.add({ type: 'turn', n: this.turn });
    // Flinch only lasts the turn it's inflicted: clear any leftover at the start
    // of each turn so a flincher who moved SECOND can't flinch the foe next turn.
    for (const s of this.sides) { s.active.movedThisTurn = false; s.active.justSwitchedIn = false; s.active.lastDamage = null; delete s.active.volatiles.flinch; }

    const actions = [
      { side: 0, choice: a0, pokemon: this.sides[0].active },
      { side: 1, choice: a1, pokemon: this.sides[1].active },
    ];
    for (const act of actions) act.priority = this.actionPriority(act);
    actions.sort((x, y) => {
      if (y.priority !== x.priority) return y.priority - x.priority;
      const sx = x.pokemon.getStat('spe'), sy = y.pokemon.getStat('spe');
      if (sx !== sy) return sy - sx;
      return this.rng.int(0, 1) ? 1 : -1;
    });

    // Switches resolve first (already ordered via high priority).
    for (const act of actions) {
      if (this.ended) break;
      if (act.choice.type === 'switch') {
        this.doSwitch(act.side, act.choice.target);
      }
    }
    // Then moves.
    for (const act of actions) {
      if (this.ended) break;
      if (act.choice.type === 'switch') continue;
      if (act.choice.type === 'pass') continue; // e.g. a failed ball throw — no move, turn still passes
      const p = this.sides[act.side].active; // may have changed via switch
      if (p.isFainted()) continue;
      this.runMove(act.side, act.choice);
    }
    if (!this.ended) this.endOfTurn();
  }

  actionPriority(act) {
    if (act.choice.type === 'switch') return 6;
    if (act.choice.type === 'pass') return 0; // no-op (failed ball throw)
    const p = act.pokemon;
    let id = act.choice.forced;
    if (!id) {
      const slot = p.moveSlots[act.choice.move];
      id = slot ? slot.id : 'struggle';
    }
    const mv = this.dex.moves[id];
    return mv ? (mv.priority || 0) : 0;
  }

  doSwitch(sideIndex, target) {
    const side = this.sides[sideIndex];
    const out = side.active;
    this.add({ type: 'switchOut', side: sideIndex, name: out.name, text: sideIndex === 0 ? `${out.name}, come back!` : `${side.name} withdrew ${out.name}!` });
    out.onSwitchOut();
    this.sendOut(sideIndex, target);
  }

  // ---- move execution ----------------------------------------------------
  runMove(sideIndex, choice) {
    const side = this.sides[sideIndex];
    const attacker = side.active;
    const defenderSide = this.opponentSide(side);
    const defender = defenderSide.active;

    // Resolve which move (forced charge/lock overrides selection).
    let slot, move;
    const locked = attacker.volatiles.twoturn || attacker.volatiles.lockedMove;
    if (choice.forced || locked) {
      const id = choice.forced || locked.moveId;
      slot = attacker.getMoveSlot(id);
      move = slot ? slot.move : this.dex.getMove(id);
    } else {
      slot = attacker.moveSlots[choice.move];
      move = slot ? slot.move : STRUGGLE;
    }

    // No usable move (all out of PP and/or disabled) -> Struggle (Gen 2). Skip
    // while a charge/lock is mid-sequence (its PP was already paid up front).
    if (move !== STRUGGLE && !locked && !this.hasUsableMove(attacker)) {
      slot = null;
      move = STRUGGLE;
    }

    // Pre-move status / volatile gates.
    if (!this.canMove(attacker, move, slot)) return;

    attacker.lastMove = move.id;
    side.lastMove = move.id;

    const v = attacker.volatiles;
    const continuing = v.twoturn && v.twoturn.moveId === move.id;
    const charge = CHARGE_MOVES[move.id];
    const sunSkip = move.id === 'solarbeam' && this.field.weather === 'sun';

    if (continuing) {
      // Unleashing a charged move; PP was already paid on the charge turn.
      delete v.twoturn; delete v.invuln;
    } else if (charge && !sunSkip) {
      // First turn: charge up.
      if (slot) slot.pp = Math.max(0, slot.pp - 1);
      this.add({ type: 'move', side: sideIndex, name: attacker.name, move: move.name, moveType: moveType(move, attacker), category: move.category, text: `${this.nameOf(attacker)} used ${move.name}!` });
      this.add({ type: 'msg', text: `${this.nameOf(attacker)} ${charge.msg}` });
      v.twoturn = { moveId: move.id };
      if (charge.invuln) v.invuln = move.id;
      if (charge.boostSelf) this.boost(attacker, charge.boostSelf, attacker);
      return;
    } else if (slot && !choice._noDeduct) {
      slot.pp = Math.max(0, slot.pp - 1);
    }

    this.add({ type: 'move', side: sideIndex, name: attacker.name, move: move.name, moveType: moveType(move, attacker), category: move.category, text: `${this.nameOf(attacker)} used ${move.name}!` });
    this.tickLockedMove(attacker, move);
    this.executeMove(attacker, defender, defenderSide, move, slot, sideIndex);
  }

  // Does this Pokemon have any move it could legally select (PP left & not disabled)?
  hasUsableMove(p) {
    return p.moveSlots.some((m) => m.pp > 0 && !(p.volatiles.disable && p.volatiles.disable.moveId === m.id));
  }

  canMove(attacker, move, slot) {
    const v = attacker.volatiles;
    // Recharge.
    if (v.mustRecharge) {
      this.add({ type: 'cant', side: this.sideIndexOf(attacker), reason: 'recharge', text: `${this.nameOf(attacker)} must recharge!` });
      delete v.mustRecharge;
      return false;
    }
    // Freeze — 10% chance to thaw each turn (Gen 2), else can't move.
    if (attacker.status === 'frz') {
      if (this.rng.chanceIn(1, 10)) {
        attacker.status = null;
        this.add({ type: 'curestatus', status: 'frz', side: this.sideIndexOf(attacker), text: `${this.nameOf(attacker)} thawed out!` });
      } else {
        this.add({ type: 'cant', reason: 'frz', text: `${this.nameOf(attacker)} is frozen solid!` });
        return false;
      }
    }
    // Sleep.
    if (attacker.status === 'slp') {
      attacker.statusData.sleepTurns--;
      if (attacker.statusData.sleepTurns <= 0) {
        attacker.status = null;
        this.add({ type: 'curestatus', status: 'slp', side: this.sideIndexOf(attacker), text: `${this.nameOf(attacker)} woke up!` });
      } else {
        this.add({ type: 'cant', reason: 'slp', text: `${this.nameOf(attacker)} is fast asleep.` });
        return false;
      }
    }
    // Flinch (cleared each turn).
    if (v.flinch) {
      this.add({ type: 'cant', reason: 'flinch', text: `${this.nameOf(attacker)} flinched and couldn't move!` });
      delete v.flinch;
      return false;
    }
    // Disable expiry handled in endOfTurn; here block disabled move.
    if (v.disable && slot && v.disable.moveId === slot.id) {
      this.add({ type: 'cant', reason: 'disable', text: `${attacker.name}'s ${move.name} is disabled!` });
      return false;
    }
    // Paralysis (full paralysis 25%).
    if (attacker.status === 'par' && this.rng.chanceIn(1, 4)) {
      this.add({ type: 'cant', reason: 'par', text: `${this.nameOf(attacker)} is fully paralyzed!` });
      return false;
    }
    // Confusion.
    if (v.confusion) {
      v.confusion.turns--;
      if (v.confusion.turns <= 0) {
        delete v.confusion;
        this.add({ type: 'curevolatile', effect: 'confusion', text: `${this.nameOf(attacker)} snapped out of confusion!` });
      } else {
        this.add({ type: 'activate', effect: 'confusion', text: `${this.nameOf(attacker)} is confused!` });
        if (this.rng.chance(0.5)) {
          // Hurt itself: 40-power typeless physical, no crit.
          const dmg = this.confusionSelfDamage(attacker);
          this.applyDamage(attacker, dmg, { cause: 'confusion' });
          this.add({ type: 'msg', text: `It hurt itself in its confusion!` });
          this.checkFaint(attacker);
          return false;
        }
      }
    }
    return true;
  }

  confusionSelfDamage(p) {
    const A = p.getStat('atk', { boosted: true });
    const D = p.getStat('def', { boosted: true });
    let dmg = (Math.floor((2 * p.level) / 5) + 2) * 40;
    dmg = Math.floor((dmg * A) / D);
    dmg = Math.floor(dmg / 50) + 2;
    return Math.max(1, dmg);
  }

  tickLockedMove(attacker, move) {
    const v = attacker.volatiles;
    if (LOCKING_MOVES[move.id]) {
      if (!v.lockedMove) {
        const [min, max] = LOCKING_MOVES[move.id];
        v.lockedMove = { moveId: move.id, turns: this.rng.int(min, max) };
      }
      v.lockedMove.turns--;
      if (v.lockedMove.turns <= 0) {
        delete v.lockedMove;
        v._endLock = move.id; // confusion applied after damage
      }
    }
  }

  executeMove(attacker, defender, defenderSide, move, slot, sideIndex) {
    const atkSideIndex = sideIndex;
    // Dream Eater only works on a sleeping target (Gen 2).
    if (move.id === 'dreameater' && defender.status !== 'slp') {
      this.add({ type: 'fail', text: 'But it failed!' });
      return;
    }
    // Custom handler entirely overrides default behaviour.
    const custom = MOVE_EFFECTS[move.id];

    // Accuracy & invulnerability check (skipped for self-targeting status moves and never-miss moves).
    const targetsFoe = move.target !== 'self' && move.target !== 'allySide' && move.id !== 'rest' &&
      !(move.category === 'Status' && (move.boosts || move.id === 'rest') && move.target === 'self');

    if (this.isProtected(defender, move) && move.target !== 'self') {
      this.add({ type: 'activate', effect: 'protect', text: `${this.nameOf(defender)} protected itself!` });
      return;
    }

    if (this.targetsOpponent(move) && !this.accuracyCheck(attacker, defender, move)) {
      this.add({ type: 'miss', side: atkSideIndex, text: `${this.nameOf(attacker)}'s attack missed!` });
      this.onMoveMiss(attacker, move);
      return;
    }

    if (custom) { custom(this, attacker, defender, defenderSide, move, slot); return; }

    if (move.category === 'Status' && !DAMAGING_ZERO_POWER.has(move.id)) {
      this.applyStatusMove(attacker, defender, defenderSide, move);
      return;
    }

    // Damaging move (handle multi-hit).
    let hits = 1;
    if (move.multihit) {
      hits = Array.isArray(move.multihit) ? this.multihitCount(move.multihit) : move.multihit;
    }
    let totalDealt = 0, anyHit = false, lastResult = null;
    for (let h = 0; h < hits; h++) {
      if (defender.isFainted()) break;
      const result = this.hitOnce(attacker, defender, defenderSide, move);
      if (result.immune) { this.add({ type: 'effmsg', eff: 'immune', text: `It doesn't affect ${this.nameOf(defender)}...` }); break; }
      lastResult = result;
      totalDealt += result.dealt;
      anyHit = true;
    }
    if (anyHit && hits > 1) this.add({ type: 'msg', text: `Hit ${Math.min(hits, this.lastHitCount || hits)} time(s)!` });

    // A Fire-type hit thaws a frozen target (Gen 2).
    if (anyHit && defender.status === 'frz' && moveType(move, attacker) === 'Fire') {
      defender.status = null;
      this.add({ type: 'curestatus', status: 'frz', side: this.sideIndexOf(defender), text: `${this.nameOf(defender)} thawed out!` });
    }

    if (anyHit && lastResult) {
      this.applyDamageSideEffects(attacker, defender, defenderSide, move, totalDealt, lastResult);
    }
    // End-of-thrash confusion.
    if (attacker.volatiles._endLock) {
      delete attacker.volatiles._endLock;
      this.confuse(attacker, attacker, 'fatigue');
    }
    this.checkFaint(defender);
    this.checkFaint(attacker);
  }

  // One strike of a damaging move; returns { dealt, crit, eff, immune }.
  hitOnce(attacker, defender, defenderSide, move) {
    // Fixed / special-damage moves.
    const fixed = this.fixedDamage(attacker, defender, move);
    let dmg, crit = false, eff = 'normal', typeMult = 1;
    let category = move.category === 'Status' ? moveCategoryFromType(moveType(move, attacker)) : move.category;
    if (fixed != null) {
      if (fixed.immune) return { dealt: 0, crit: false, eff: 'immune', immune: true };
      dmg = fixed.damage; eff = fixed.eff || 'normal';
    } else {
      crit = this.rollCrit(attacker, move);
      const powerOverride = this.variablePower(attacker, defender, move);
      const res = calcDamage(this, attacker, defender, move, defenderSide, { crit, powerOverride });
      if (res.effectiveness === 'immune') return { dealt: 0, crit: false, eff: 'immune', immune: true };
      dmg = res.damage; eff = res.effectiveness; typeMult = res.typeMult; crit = res.crit;
      if (res.category) category = res.category;
    }

    // Substitute soaks damage.
    if (defender.volatiles.substitute) {
      const sub = defender.volatiles.substitute;
      const before = sub.hp;
      sub.hp -= dmg;
      this.add({ type: 'msg', text: `The substitute took the hit!` });
      if (crit) this.add({ type: 'crit', text: 'A critical hit!' });
      if (eff === 'super') this.add({ type: 'effmsg', eff, text: "It's super effective!" });
      if (eff === 'resist') this.add({ type: 'effmsg', eff, text: "It's not very effective..." });
      if (sub.hp <= 0) { delete defender.volatiles.substitute; this.add({ type: 'msg', text: `${this.nameOf(defender)}'s substitute faded!` }); }
      return { dealt: 0, crit, eff, immune: false, hitSub: true, subDamage: before - Math.max(0, sub.hp) };
    }

    const dealt = this.applyDamage(defender, dmg, { cause: 'move', crit, eff });
    defender.lastDamage = { amount: dealt, category, type: moveType(move, attacker) };
    if (crit) this.add({ type: 'crit', text: 'A critical hit!' });
    if (eff === 'super') this.add({ type: 'effmsg', eff, text: "It's super effective!" });
    if (eff === 'resist') this.add({ type: 'effmsg', eff, text: "It's not very effective..." });
    return { dealt, crit, eff, immune: false };
  }

  // Apply recoil, drain, secondary effects, self-boosts, selfdestruct, etc.
  applyDamageSideEffects(attacker, defender, defenderSide, move, totalDealt, lastResult) {
    // Recoil.
    if (move.recoil && totalDealt > 0) {
      const r = Math.max(1, Math.floor((totalDealt * move.recoil[0]) / move.recoil[1]));
      this.applyDamage(attacker, r, { cause: 'recoil' });
      this.add({ type: 'msg', text: `${this.nameOf(attacker)} is hit with recoil!` });
    }
    // Drain (Absorb/Mega Drain/Giga Drain/Leech Life/Dream Eater).
    if (move.drain && totalDealt > 0) {
      const heal = Math.max(1, Math.floor((totalDealt * move.drain[0]) / move.drain[1]));
      attacker.heal(heal);
      this.add({ type: 'heal', side: this.sideIndexOf(attacker), name: attacker.name, hp: attacker.hp, maxhp: attacker.maxhp, hpPct: attacker.hpPercent(), text: `${this.nameOf(defender)} had its energy drained!` });
    }
    // Self-destruct.
    if (move.selfdestruct) {
      this.applyDamage(attacker, attacker.hp, { cause: 'selfdestruct' });
    }
    // Recharge moves.
    if (RECHARGE_MOVES.has(move.id)) attacker.volatiles.mustRecharge = true;
    // Secondary effects (skip if it hit a substitute).
    if (!lastResult.hitSub) {
      const secondaries = move.secondaries || (move.secondary ? [move.secondary] : []);
      for (const sec of secondaries) {
        if (!sec || !this.rng.chance((sec.chance ?? 100) / 100)) continue;
        const tgt = sec.self ? attacker : defender;
        if (sec.status) this.setStatus(tgt, sec.status, attacker);
        if (sec.volatileStatus === 'flinch') this.tryFlinch(defender);
        else if (sec.volatileStatus === 'confusion') this.confuse(defender, attacker);
        if (sec.boosts) this.boost(tgt, sec.boosts, attacker);
        if (sec.self && sec.self.boosts) this.boost(attacker, sec.self.boosts, attacker);
      }
    }
    // Move-level self boosts after damage (e.g., Ancient Power-like, Meteor Mash n/a).
    if (move.self && move.self.boosts) this.boost(attacker, move.self.boosts, attacker);
  }

  multihitCount(range) {
    const [min, max] = range;
    if (max - min === 3) {
      // Gen 2 distribution for 2-5 hit moves.
      const r = this.rng.int(1, 8);
      this.lastHitCount = r <= 3 ? 2 : r <= 6 ? 3 : r === 7 ? 4 : 5;
    } else {
      this.lastHitCount = this.rng.int(min, max);
    }
    return this.lastHitCount;
  }

  // Returns { damage } / { immune } for fixed/level/variable-power moves, else null.
  fixedDamage(attacker, defender, move) {
    const id = move.id;
    const immuneCheck = (type) => effectivenessOf(this.dex, type, defender) === 0;
    switch (id) {
      case 'seismictoss':
      case 'nightshade':
        if (immuneCheck(move.type)) return { immune: true };
        return { damage: attacker.level };
      case 'dragonrage': return { damage: 40 };
      case 'sonicboom': return { damage: 20 };
      case 'psywave': {
        if (immuneCheck('Psychic')) return { immune: true };
        return { damage: Math.max(1, Math.floor((attacker.level * this.rng.int(5, 15)) / 10)) };
      }
      case 'superfang': {
        if (immuneCheck(move.type)) return { immune: true };
        return { damage: Math.max(1, Math.floor(defender.hp / 2)) };
      }
      case 'fissure': case 'horndrill': case 'guillotine': {
        if (immuneCheck(move.type)) return { immune: true };
        if (defender.level > attacker.level) return { damage: 0, eff: 'normal' };
        return { damage: defender.hp, eff: 'normal', ohko: true };
      }
      default: return null;
    }
  }

  // Power for variable-power moves; returns null to use the move's basePower.
  variablePower(attacker, defender, move) {
    switch (move.id) {
      case 'flail':
      case 'reversal': {
        const ratio = attacker.hp / attacker.maxhp;
        if (ratio <= 0.0417) return 200;
        if (ratio <= 0.1042) return 150;
        if (ratio <= 0.2083) return 100;
        if (ratio <= 0.3542) return 80;
        if (ratio <= 0.6875) return 40;
        return 20;
      }
      case 'magnitude': {
        const r = this.rng.int(4, 10);
        const power = { 4: 10, 5: 30, 6: 50, 7: 70, 8: 90, 9: 110, 10: 150 }[r];
        this.add({ type: 'msg', text: `Magnitude ${r}!` });
        return power;
      }
      // Friendship-based moves; PokeWeek pokemon default to max happiness.
      case 'return': return 102;
      case 'frustration': return 1;
      case 'present': {
        // Gen 2: ~52/256 heal the target, otherwise 40/80/120 power.
        const roll = this.rng.int(1, 256);
        if (roll <= 52) {
          const healAmt = Math.max(1, Math.floor(defender.maxhp / 4));
          defender.heal(healAmt);
          this.add({ type: 'heal', side: this.sideIndexOf(defender), name: defender.name, hp: defender.hp, maxhp: defender.maxhp, hpPct: defender.hpPercent(), text: `${this.nameOf(defender)} regained health!` });
          return 0;
        }
        if (roll <= 154) return 40;
        if (roll <= 230) return 80;
        return 120;
      }
      default: return null;
    }
  }

  rollCrit(attacker, move) {
    let stage = 0;
    const cr = move.critRatio || 1;
    if (cr >= 4) stage = 3; else if (cr === 3) stage = 2; else if (cr === 2) stage = 1;
    if (attacker.volatiles.focusenergy) stage += 1;
    if (move.willCrit) return true;
    return this.rng.chance(critChance(stage));
  }

  // ---- status-move application ------------------------------------------
  applyStatusMove(attacker, defender, defenderSide, move) {
    let didSomething = false;
    // Self vs foe boosts.
    if (move.boosts) {
      const tgt = (move.target === 'self') ? attacker : defender;
      if (this.boost(tgt, move.boosts, attacker)) didSomething = true;
      else if (move.target === 'self') didSomething = true;
    }
    if (move.status) {
      if (this.setStatus(defender, move.status, attacker)) didSomething = true;
    }
    if (move.volatileStatus) {
      if (move.volatileStatus === 'confusion') { if (this.confuse(defender, attacker)) didSomething = true; }
      else if (move.volatileStatus === 'leechseed') { if (this.applyLeechSeed(defender, attacker)) didSomething = true; }
      else if (move.volatileStatus === 'flinch') { /* status flinch rare */ }
      else { didSomething = this.applyGenericVolatile(defender, move.volatileStatus) || didSomething; }
    }
    if (move.heal) {
      const amt = Math.floor((attacker.maxhp * move.heal[0]) / move.heal[1]);
      const healed = attacker.heal(amt);
      if (healed > 0) { didSomething = true; this.add({ type: 'heal', side: this.sideIndexOf(attacker), name: attacker.name, hp: attacker.hp, maxhp: attacker.maxhp, hpPct: attacker.hpPercent(), text: `${this.nameOf(attacker)} regained health!` }); }
    }
    if (move.weather) { if (this.setWeather(move.weather)) didSomething = true; }
    if (move.sideCondition) { if (this.addSideCondition(this.sideOf(attacker), move.sideCondition)) didSomething = true; }
    if (!didSomething) this.add({ type: 'fail', text: 'But it failed!' });
  }

  applyGenericVolatile(target, vol) {
    // Some volatiles are structured objects ({ turns }, { bySide }, ...) read
    // elsewhere; they must only be created by their dedicated handlers. Never
    // stamp them as a bare boolean here (would corrupt end-of-turn bookkeeping).
    if (STRUCTURED_VOLATILES.has(vol)) return false;
    if (target.volatiles[vol]) return false;
    target.volatiles[vol] = true;
    this.add({ type: 'volatile', effect: vol, text: `${this.nameOf(target)} is affected!` });
    return true;
  }

  // ---- shared effect helpers --------------------------------------------
  boost(pokemon, boosts, source) {
    let any = false;
    const fromFoe = source && this.sideOf(source) !== this.sideOf(pokemon);
    for (const [stat, raw] of Object.entries(boosts)) {
      let delta = raw;
      if (delta < 0 && fromFoe && pokemon.volatiles.mist) {
        this.add({ type: 'activate', effect: 'mist', text: `${this.nameOf(pokemon)} is protected by Mist!` });
        continue;
      }
      const before = pokemon.boosts[stat] || 0;
      let after = Math.max(-6, Math.min(6, before + delta));
      if (after === before) {
        this.add({ type: 'boostfail', stat, text: `${this.nameOf(pokemon)}'s ${STAT_NAMES[stat]} won't go ${delta > 0 ? 'higher' : 'lower'}!` });
        continue;
      }
      pokemon.boosts[stat] = after;
      any = true;
      const amount = after - before;
      const word = amount >= 2 ? 'sharply rose' : amount === 1 ? 'rose' : amount === -1 ? 'fell' : 'harshly fell';
      this.add({ type: 'boost', side: this.sideIndexOf(pokemon), name: pokemon.name, stat, amount, text: `${this.nameOf(pokemon)}'s ${STAT_NAMES[stat]} ${word}!` });
    }
    return any;
  }

  setStatus(pokemon, status, source) {
    if (pokemon.isFainted()) return false;
    if (pokemon.status) return false;
    if (pokemon.volatiles.substitute && source && source !== pokemon) return false;
    const side = this.sideOf(pokemon);
    if (side.conditions.safeguard) { this.add({ type: 'activate', effect: 'safeguard', text: `${this.nameOf(pokemon)} is protected by Safeguard!` }); return false; }
    // Type immunities.
    if ((status === 'brn') && pokemon.hasType('Fire')) return false;
    if ((status === 'frz') && pokemon.hasType('Ice')) return false;
    if ((status === 'psn' || status === 'tox') && (pokemon.hasType('Poison') || pokemon.hasType('Steel'))) return false;
    pokemon.status = status;
    if (status === 'slp') pokemon.statusData.sleepTurns = this.rng.int(1, 3); // modern 1-3 turn sleep
    if (status === 'tox') pokemon.statusData.toxicStage = 1;
    const txt = {
      brn: 'was burned!', par: 'is paralyzed! It may be unable to move!', psn: 'was poisoned!',
      tox: 'was badly poisoned!', slp: 'fell asleep!', frz: 'was frozen solid!',
    }[status];
    this.add({ type: 'status', side: this.sideIndexOf(pokemon), name: pokemon.name, status, text: `${this.nameOf(pokemon)} ${txt}` });
    return true;
  }

  confuse(target, source, cause) {
    if (target.volatiles.confusion) return false;
    if (target.volatiles.substitute && source !== target) return false;
    target.volatiles.confusion = { turns: this.rng.int(2, 5) };
    this.add({ type: 'volatile', effect: 'confusion', side: this.sideIndexOf(target), text: `${this.nameOf(target)} became confused${cause === 'fatigue' ? ' due to fatigue' : ''}!` });
    return true;
  }

  tryFlinch(target) {
    if (target.isFainted()) return;
    target.volatiles.flinch = true; // resolved next time it tries to move this turn
  }

  applyLeechSeed(target, source) {
    if (target.hasType('Grass')) { this.add({ type: 'msg', text: `It doesn't affect ${this.nameOf(target)}...` }); return false; }
    if (target.volatiles.leechseed) return false;
    target.volatiles.leechseed = { bySide: this.sideIndexOf(source) };
    this.add({ type: 'volatile', effect: 'leechseed', side: this.sideIndexOf(target), text: `${this.nameOf(target)} was seeded!` });
    return true;
  }

  isProtected(defender, move) {
    return !!defender.volatiles.protect && move.target !== 'self' && (move.category !== 'Status' || move.boosts || move.status);
  }

  targetsOpponent(move) {
    return move.target === 'normal' || move.target === 'any' || move.target === 'allAdjacentFoes' || move.target === 'randomNormal' || move.target === undefined;
  }

  accuracyCheck(attacker, defender, move) {
    // Semi-invulnerability (Fly/Dig).
    if (defender.volatiles.invuln) {
      const allowed = HITS_INVULN[defender.volatiles.invuln];
      if (!allowed || !allowed.has(move.id)) return false;
    }
    if (move.accuracy === true) return true;
    let acc = move.accuracy;
    // OHKO accuracy is level-influenced (handled in fixedDamage), keep base here.
    const accMod = accStageMultiplier(attacker.boosts.accuracy || 0);
    const evaMod = accStageMultiplier(defender.boosts.evasion || 0);
    let chance = acc * accMod / evaMod;
    return this.rng.int(1, 100) <= chance;
  }

  onMoveMiss(attacker, move) {
    // High Jump Kick / Jump Kick crash damage.
    if (move.id === 'jumpkick' || move.id === 'highjumpkick') {
      const crash = Math.min(attacker.hp, Math.floor(attacker.maxhp / 8) || 1);
      this.applyDamage(attacker, crash, { cause: 'crash' });
      this.add({ type: 'msg', text: `${this.nameOf(attacker)} kept going and crashed!` });
      this.checkFaint(attacker);
    }
  }

  // ---- damage / heal application & faints --------------------------------
  applyDamage(pokemon, amount, meta = {}) {
    const dealt = pokemon.damage(amount);
    this.add({
      type: 'damage', side: this.sideIndexOf(pokemon), name: pokemon.name, dmg: dealt,
      hp: pokemon.hp, maxhp: pokemon.maxhp, hpPct: pokemon.hpPercent(),
      crit: !!meta.crit, eff: meta.eff || 'normal', cause: meta.cause || 'move',
    });
    return dealt;
  }

  healPokemon(pokemon, amount, text) {
    const healed = pokemon.heal(amount);
    if (healed > 0) this.add({ type: 'heal', side: this.sideIndexOf(pokemon), name: pokemon.name, hp: pokemon.hp, maxhp: pokemon.maxhp, hpPct: pokemon.hpPercent(), text });
    return healed;
  }

  checkFaint(pokemon) {
    if (!pokemon.isFainted() || pokemon._faintLogged) return;
    pokemon._faintLogged = true;
    pokemon.fainted = true;
    this.add({ type: 'faint', side: this.sideIndexOf(pokemon), name: pokemon.name, text: `${this.nameOf(pokemon)} fainted!` });
    // Destiny Bond.
    if (pokemon.volatiles.destinybond && pokemon.volatiles.destinybond.from) {
      const killer = pokemon.volatiles.destinybond.from;
      if (killer && !killer.isFainted()) {
        this.applyDamage(killer, killer.hp, { cause: 'destinybond' });
        this.add({ type: 'msg', text: `${this.nameOf(pokemon)} took ${this.nameOf(killer)} down with it!` });
        this.checkFaint(killer);
      }
    }
  }

  // ---- end of turn -------------------------------------------------------
  endOfTurn() {
    const order = this.speedOrderedActives();
    // Weather countdown / damage.
    if (this.field.weather === 'sandstorm') {
      for (const p of order) {
        if (p.isFainted()) continue;
        if (p.hasType('Rock') || p.hasType('Ground') || p.hasType('Steel')) continue;
        this.applyDamage(p, Math.max(1, Math.floor(p.maxhp / 8)), { cause: 'sandstorm' });
        this.add({ type: 'msg', text: `${this.nameOf(p)} is buffeted by the sandstorm!` });
        this.checkFaint(p);
      }
    }
    if (this.field.weather) {
      this.field.weatherTurns--;
      if (this.field.weatherTurns <= 0) { this.add({ type: 'weather', weather: null, text: this.weatherEndText() }); this.field.weather = null; }
    }

    for (const p of order) {
      if (p.isFainted()) continue;
      // Binding (Wrap etc).
      if (p.volatiles.partiallytrapped) {
        const t = p.volatiles.partiallytrapped;
        t.turns--;
        this.applyDamage(p, Math.max(1, Math.floor(p.maxhp / 16)), { cause: 'bind' });
        this.add({ type: 'msg', text: `${this.nameOf(p)} is hurt by ${t.moveName}!` });
        if (t.turns <= 0) { delete p.volatiles.partiallytrapped; this.add({ type: 'msg', text: `${this.nameOf(p)} was freed!` }); }
        this.checkFaint(p);
      }
      if (p.isFainted()) continue;
      // Leech Seed.
      if (p.volatiles.leechseed && !p.hasType('Grass')) {
        const drain = Math.max(1, Math.floor(p.maxhp / 8));
        const taken = this.applyDamage(p, drain, { cause: 'leechseed' });
        this.add({ type: 'msg', text: `${this.nameOf(p)}'s health is sapped by Leech Seed!` });
        const ally = this.sides[p.volatiles.leechseed.bySide].active;
        if (ally && !ally.isFainted()) this.healPokemon(ally, taken, null);
        this.checkFaint(p);
      }
      if (p.isFainted()) continue;
      // Status residual.
      if (p.status === 'brn') { this.applyDamage(p, Math.max(1, Math.floor(p.maxhp / 8)), { cause: 'brn' }); this.add({ type: 'msg', text: `${this.nameOf(p)} is hurt by its burn!` }); this.checkFaint(p); }
      else if (p.status === 'psn') { this.applyDamage(p, Math.max(1, Math.floor(p.maxhp / 8)), { cause: 'psn' }); this.add({ type: 'msg', text: `${this.nameOf(p)} is hurt by poison!` }); this.checkFaint(p); }
      else if (p.status === 'tox') {
        const dmg = Math.max(1, Math.floor((p.maxhp * p.statusData.toxicStage) / 16));
        this.applyDamage(p, dmg, { cause: 'tox' });
        this.add({ type: 'msg', text: `${this.nameOf(p)} is hurt by poison!` });
        p.statusData.toxicStage++;
        this.checkFaint(p);
      }
      if (p.isFainted()) continue;
      // Nightmare / Curse.
      if (p.volatiles.nightmare && p.status === 'slp') { this.applyDamage(p, Math.max(1, Math.floor(p.maxhp / 4)), { cause: 'nightmare' }); this.add({ type: 'msg', text: `${this.nameOf(p)} is locked in a nightmare!` }); this.checkFaint(p); }
      if (p.volatiles.curse) { this.applyDamage(p, Math.max(1, Math.floor(p.maxhp / 4)), { cause: 'curse' }); this.add({ type: 'msg', text: `${this.nameOf(p)} is afflicted by the curse!` }); this.checkFaint(p); }
    }

    // Side condition countdowns.
    for (const side of this.sides) {
      for (const cond of ['reflect', 'lightscreen', 'safeguard', 'mist']) {
        if (side.conditions[cond]) {
          side.conditions[cond].turns--;
          if (side.conditions[cond].turns <= 0) { delete side.conditions[cond]; this.add({ type: 'sideend', side: this.sides.indexOf(side), condition: cond, text: this.sideEndText(cond, side) }); }
        }
      }
    }

    // Perish Song.
    for (const p of order) {
      if (p.volatiles.perishsong) {
        p.volatiles.perishsong.turns--;
        this.add({ type: 'msg', text: `${this.nameOf(p)}'s perish count fell to ${p.volatiles.perishsong.turns}!` });
        if (p.volatiles.perishsong.turns <= 0) { this.applyDamage(p, p.hp, { cause: 'perishsong' }); this.checkFaint(p); }
      }
      // Disable / Encore countdown.
      if (p.volatiles.disable) { if (--p.volatiles.disable.turns <= 0) { delete p.volatiles.disable; this.add({ type: 'msg', text: `${p.name}'s move is no longer disabled!` }); } }
      if (p.volatiles.encore) { if (--p.volatiles.encore.turns <= 0) delete p.volatiles.encore; }
    }
  }

  speedOrderedActives() {
    const a = this.sides[0].active, b = this.sides[1].active;
    const sa = a.getStat('spe'), sb = b.getStat('spe');
    if (sa === sb) return this.rng.int(0, 1) ? [b, a] : [a, b];
    return sa > sb ? [a, b] : [b, a];
  }

  // ---- weather & side conditions ----------------------------------------
  setWeather(weather) {
    if (this.field.weather === weather) return false;
    this.field.weather = weather;
    this.field.weatherTurns = 5;
    const txt = { rain: 'It started to rain!', sun: 'The sunlight got bright!', sandstorm: 'A sandstorm kicked up!' }[weather];
    this.add({ type: 'weather', weather, text: txt });
    return true;
  }
  weatherEndText() {
    return { rain: 'The rain stopped.', sun: 'The sunlight faded.', sandstorm: 'The sandstorm subsided.' }[this.field.weather] || 'The weather cleared.';
  }

  addSideCondition(side, cond) {
    if (side.conditions[cond]) return false;
    const turns = 5;
    side.conditions[cond] = { turns };
    this.add({ type: 'sidestart', side: this.sides.indexOf(side), condition: cond, text: this.sideStartText(cond, side) });
    return true;
  }
  sideStartText(cond, side) {
    const who = side.isPlayer ? 'your team' : "the foe's team";
    return {
      reflect: `Reflect raised ${who}'s Defense!`, lightscreen: `Light Screen raised ${who}'s Sp. Def!`,
      safeguard: `${who} became cloaked in a mystical veil!`, mist: `${who} became shrouded in mist!`,
      spikes: `Spikes were scattered around ${who}!`,
    }[cond] || `${cond} started.`;
  }
  sideEndText(cond, side) {
    const who = side.isPlayer ? 'Your team' : "The foe's team";
    return { reflect: `${who}'s Reflect wore off.`, lightscreen: `${who}'s Light Screen wore off.`, safeguard: `${who} is no longer protected by Safeguard.`, mist: `${who}'s Mist lifted.` }[cond] || `${cond} ended.`;
  }

  // ---- after-turn faint resolution & win check --------------------------
  afterTurn() {
    if (this.ended) { this.state = 'end'; return; }
    // Determine win/loss.
    const alive = [this.sides[0].hasAlive(), this.sides[1].hasAlive()];
    if (!alive[0] || !alive[1]) {
      this.ended = true;
      this.state = 'end';
      this.winner = !alive[0] && !alive[1] ? 'tie' : (alive[0] ? 0 : 1);
      const txt = this.winner === 'tie' ? 'The battle ended in a tie!' : `${this.sides[this.winner].name} won the battle!`;
      this.add({ type: 'win', side: this.winner, text: txt });
      return;
    }
    // Endless Battle safeguard: a few pathological matchups (e.g. two Ghosts
    // both out of PP, where Struggle is type-immune for both) can never resolve
    // on their own. After a hard turn cap, decide by remaining HP so the game
    // never softlocks.
    if (this.turn >= 1000) {
      this.ended = true;
      this.state = 'end';
      const h0 = this.sideHpFraction(0), h1 = this.sideHpFraction(1);
      this.winner = h0 === h1 ? 'tie' : (h0 > h1 ? 0 : 1);
      this.add({ type: 'msg', text: 'The battle dragged on with no end in sight!' });
      const txt = this.winner === 'tie' ? 'The battle ended in a tie!' : `${this.sides[this.winner].name} won the battle!`;
      this.add({ type: 'win', side: this.winner, text: txt });
      return;
    }
    // Forced switches for fainted actives.
    for (let i = 0; i < 2; i++) {
      if (this.sides[i].active.isFainted()) this.needSwitch[i] = true;
    }
    this.makeRequest();
  }

  // Total remaining HP of a side as a fraction of its team's max HP.
  sideHpFraction(sideIndex) {
    const team = this.sides[sideIndex].team;
    let cur = 0, max = 0;
    for (const p of team) { cur += p.hp; max += p.maxhp; }
    return max ? cur / max : 0;
  }
}

// ===========================================================================
//  Custom move handlers (override default execution for signature moves).
//  Signature: (battle, attacker, defender, defenderSide, move, slot)
// ===========================================================================
const MOVE_EFFECTS = {
  rest(b, atk) {
    if (atk.hp >= atk.maxhp) { b.add({ type: 'fail', text: 'But it failed!' }); return; }
    atk.status = 'slp';
    atk.statusData.sleepTurns = 3; // wakes after 2 full turns
    atk.heal(atk.maxhp);
    b.add({ type: 'status', side: b.sideIndexOf(atk), name: atk.name, status: 'slp', text: `${b.nameOf(atk)} went to sleep and became healthy!` });
    b.add({ type: 'heal', side: b.sideIndexOf(atk), name: atk.name, hp: atk.hp, maxhp: atk.maxhp, hpPct: atk.hpPercent() });
  },
  substitute(b, atk) {
    const cost = Math.floor(atk.maxhp / 4);
    if (atk.hp <= cost || atk.volatiles.substitute) { b.add({ type: 'fail', text: 'But it failed!' }); return; }
    b.applyDamage(atk, cost, { cause: 'substitute' });
    atk.volatiles.substitute = { hp: cost + 1 };
    b.add({ type: 'volatile', effect: 'substitute', side: b.sideIndexOf(atk), text: `${b.nameOf(atk)} put up a substitute!` });
  },
  protect: protectHandler, detect: protectHandler, endure: endureHandler,
  leechseed(b, atk, def) { if (!b.applyLeechSeed(def, atk)) b.add({ type: 'fail', text: 'But it failed!' }); },
  haze(b) {
    for (const s of b.sides) for (const k of Object.keys(s.active.boosts)) s.active.boosts[k] = 0;
    b.add({ type: 'activate', effect: 'haze', text: 'All stat changes were eliminated!' });
  },
  reflect(b, atk) { if (!b.addSideCondition(b.sideOf(atk), 'reflect')) b.add({ type: 'fail', text: 'But it failed!' }); },
  lightscreen(b, atk) { if (!b.addSideCondition(b.sideOf(atk), 'lightscreen')) b.add({ type: 'fail', text: 'But it failed!' }); },
  safeguard(b, atk) { if (!b.addSideCondition(b.sideOf(atk), 'safeguard')) b.add({ type: 'fail', text: 'But it failed!' }); },
  mist(b, atk) { if (!b.addSideCondition(b.sideOf(atk), 'mist')) b.add({ type: 'fail', text: 'But it failed!' }); },
  spikes(b, atk) { const foe = b.opponentSide(b.sideOf(atk)); if (foe.conditions.spikes) { b.add({ type: 'fail', text: 'But it failed!' }); return; } foe.conditions.spikes = { layers: 1 }; b.add({ type: 'sidestart', side: b.sides.indexOf(foe), condition: 'spikes', text: b.sideStartText('spikes', foe) }); },
  raindance(b) { if (!b.setWeather('rain')) b.add({ type: 'fail', text: 'But it failed!' }); },
  sunnyday(b) { if (!b.setWeather('sun')) b.add({ type: 'fail', text: 'But it failed!' }); },
  sandstorm(b) { if (!b.setWeather('sandstorm')) b.add({ type: 'fail', text: 'But it failed!' }); },
  focusenergy(b, atk) { if (atk.volatiles.focusenergy) { b.add({ type: 'fail', text: 'But it failed!' }); return; } atk.volatiles.focusenergy = true; b.add({ type: 'activate', effect: 'focusenergy', text: `${b.nameOf(atk)} is getting pumped!` }); },
  confuseray(b, atk, def) { if (!b.confuse(def, atk)) b.add({ type: 'fail', text: 'But it failed!' }); },
  supersonic(b, atk, def) { if (!b.confuse(def, atk)) b.add({ type: 'fail', text: 'But it failed!' }); },
  sweetkiss(b, atk, def) { if (!b.confuse(def, atk)) b.add({ type: 'fail', text: 'But it failed!' }); },
  swagger(b, atk, def) { b.boost(def, { atk: 2 }, atk); b.confuse(def, atk); },
  flatter(b, atk, def) { b.boost(def, { spa: 1 }, atk); b.confuse(def, atk); },
  painsplit(b, atk, def) {
    const avg = Math.floor((atk.hp + def.hp) / 2);
    atk.hp = Math.min(atk.maxhp, avg); def.hp = Math.min(def.maxhp, avg);
    b.add({ type: 'damage', side: b.sideIndexOf(atk), name: atk.name, hp: atk.hp, maxhp: atk.maxhp, hpPct: atk.hpPercent(), dmg: 0 });
    b.add({ type: 'damage', side: b.sideIndexOf(def), name: def.name, hp: def.hp, maxhp: def.maxhp, hpPct: def.hpPercent(), dmg: 0 });
    b.add({ type: 'msg', text: 'The battlers shared their pain!' });
  },
  bellydrum(b, atk) {
    const cost = Math.floor(atk.maxhp / 2);
    if (atk.hp <= cost) { b.add({ type: 'fail', text: 'But it failed!' }); return; }
    b.applyDamage(atk, cost, { cause: 'bellydrum' });
    atk.boosts.atk = 6;
    b.add({ type: 'boost', side: b.sideIndexOf(atk), name: atk.name, stat: 'atk', amount: 6, text: `${b.nameOf(atk)} cut its own HP and maximized Attack!` });
  },
  destinybond(b, atk) { atk.volatiles.destinybond = { from: b.foeOf(atk) }; b.add({ type: 'activate', effect: 'destinybond', text: `${b.nameOf(atk)} is trying to take its foe down with it!` }); },
  perishsong(b) {
    for (const s of b.sides) { const p = s.active; if (!p.volatiles.perishsong) p.volatiles.perishsong = { turns: 3 }; }
    b.add({ type: 'msg', text: 'All Pokemon hearing the song will faint in three turns!' });
  },
  counter(b, atk, def) {
    const last = atk.lastDamage;
    if (last && last.category === 'Physical' && last.amount > 0) {
      b.applyDamage(def, last.amount * 2, { cause: 'counter' }); b.checkFaint(def);
    } else b.add({ type: 'fail', text: 'But it failed!' });
  },
  mirrorcoat(b, atk, def) {
    const last = atk.lastDamage;
    if (last && last.category === 'Special' && last.amount > 0) {
      b.applyDamage(def, last.amount * 2, { cause: 'mirrorcoat' }); b.checkFaint(def);
    } else b.add({ type: 'fail', text: 'But it failed!' });
  },
  nightmare(b, atk, def) { if (def.status === 'slp' && !def.volatiles.nightmare) { def.volatiles.nightmare = true; b.add({ type: 'volatile', effect: 'nightmare', text: `${b.nameOf(def)} began having a nightmare!` }); } else b.add({ type: 'fail', text: 'But it failed!' }); },
  curse(b, atk, def) {
    if (atk.hasType('Ghost')) {
      const cost = Math.floor(atk.maxhp / 2);
      b.applyDamage(atk, cost, { cause: 'curse' });
      def.volatiles.curse = true;
      b.add({ type: 'volatile', effect: 'curse', text: `${b.nameOf(atk)} cut its HP and laid a curse on ${b.nameOf(def)}!` });
      b.checkFaint(atk);
    } else {
      b.boost(atk, { spe: -1, atk: 1, def: 1 }, atk);
    }
  },
  foresight(b, atk, def) { def.volatiles.foresight = true; b.add({ type: 'activate', effect: 'foresight', text: `${b.nameOf(atk)} identified ${b.nameOf(def)}!` }); },
  meanlook(b, atk, def) { def.volatiles.meanlook = true; b.add({ type: 'activate', effect: 'meanlook', text: `${b.nameOf(def)} can no longer escape!` }); },
  spiderweb(b, atk, def) { def.volatiles.meanlook = true; b.add({ type: 'activate', effect: 'meanlook', text: `${b.nameOf(def)} can no longer escape!` }); },
  disable(b, atk, def) {
    if (def.lastMove && def.getMoveSlot(def.lastMove) && !def.volatiles.disable) {
      def.volatiles.disable = { moveId: def.lastMove, turns: b.rng.int(2, 8) };
      b.add({ type: 'activate', effect: 'disable', text: `${b.nameOf(def)}'s ${b.dex.getMove(def.lastMove).name} was disabled!` });
    } else b.add({ type: 'fail', text: 'But it failed!' });
  },
  encore(b, atk, def) {
    if (def.lastMove && def.getMoveSlot(def.lastMove) && !def.volatiles.encore) {
      def.volatiles.encore = { moveId: def.lastMove, turns: b.rng.int(3, 6) };
      b.add({ type: 'activate', effect: 'encore', text: `${b.nameOf(def)} received an encore!` });
    } else b.add({ type: 'fail', text: 'But it failed!' });
  },
  whirlwind: forceSwitchHandler, roar: forceSwitchHandler,
  psychup(b, atk, def) { atk.boosts = { ...def.boosts }; b.add({ type: 'activate', effect: 'psychup', text: `${b.nameOf(atk)} copied ${b.nameOf(def)}'s stat changes!` }); },
  conversion(b, atk) {
    const t = atk.moveSlots.map((m) => moveType(m.move, atk)).find((x) => !atk.hasType(x));
    if (t) { atk.types = [t]; b.add({ type: 'activate', effect: 'conversion', text: `${b.nameOf(atk)} changed its type to ${t}!` }); }
    else b.add({ type: 'fail', text: 'But it failed!' });
  },
  splash(b) { b.add({ type: 'msg', text: 'But nothing happened!' }); },
  metronome(b, atk, def, defSide, move, slot) {
    const ids = Object.keys(b.dex.moves).filter((id) => id !== 'metronome' && id !== 'struggle');
    const picked = b.dex.getMove(b.rng.pick(ids));
    b.add({ type: 'msg', text: `Waggling a finger let it use ${picked.name}!` });
    // Run the chosen move through the normal executor so its custom handler
    // (Disable/Encore/etc.) fires correctly instead of a broken generic volatile.
    b.executeMove(atk, def, defSide, picked, null, b.sideIndexOf(atk));
  },
  mirrormove(b, atk, def, defSide) {
    const last = def.lastMove;
    if (last && last !== 'mirrormove') {
      b.executeMove(atk, def, defSide, b.dex.getMove(last), null, b.sideIndexOf(atk));
    } else b.add({ type: 'fail', text: 'But it failed!' });
  },
};

function protectHandler(b, atk) {
  // Consecutive use lowers success chance (Gen 2: 1, 1/2, 1/4...).
  const streak = atk.volatiles._protectStreak || 0;
  const success = b.rng.next() < 1 / (2 ** streak);
  if (success) {
    atk.volatiles.protect = true;
    atk.volatiles._protectStreak = streak + 1;
    b.add({ type: 'activate', effect: 'protect', text: `${b.nameOf(atk)} protected itself!` });
  } else {
    atk.volatiles._protectStreak = 0;
    b.add({ type: 'fail', text: 'But it failed!' });
  }
}
function endureHandler(b, atk) {
  const streak = atk.volatiles._protectStreak || 0;
  const success = b.rng.next() < 1 / (2 ** streak);
  if (success) { atk.volatiles.endure = true; atk.volatiles._protectStreak = streak + 1; b.add({ type: 'activate', effect: 'endure', text: `${b.nameOf(atk)} braced itself!` }); }
  else { atk.volatiles._protectStreak = 0; b.add({ type: 'fail', text: 'But it failed!' }); }
}
function forceSwitchHandler(b, atk, def) {
  const side = b.opponentSide(b.sideOf(atk));
  const options = side.switchableIndices();
  if (b.kind === 'wild' && b.sideIndexOf(def) === 1) { b.ended = true; b.add({ type: 'msg', text: `${b.nameOf(def)} fled!` }); b.winner = 0; return; }
  if (options.length === 0) { b.add({ type: 'fail', text: 'But it failed!' }); return; }
  const pick = b.rng.pick(options);
  b.add({ type: 'msg', text: `${b.nameOf(def)} was dragged out!` });
  def.onSwitchOut();
  b.sendOut(b.sides.indexOf(side), pick);
}
