import { computeStats, DEFAULT_IVS, ZERO_EVS } from './stats.js';
import { statStageMultiplier } from './constants.js';
import { toId } from './dex.js';

// A battle instance of a Pokemon, built from a "set" (species/level/moves/...).
export class Pokemon {
  constructor(set, dex) {
    this.dex = dex;
    this.set = set;
    this.species = dex.getSpecies(set.species);
    this.num = this.species.num;
    this.level = set.level || 50;
    this.name = set.nickname || this.species.name;
    this.types = [...this.species.types];
    this.gender = set.gender || null;
    this.shiny = !!set.shiny;
    this.item = set.item ? toId(set.item) : null;

    this.ivs = set.ivs || DEFAULT_IVS;          // genetics, 0-31 per stat
    this.evs = set.evs || ZERO_EVS;             // effort values, 0-252 per stat
    this.stats = computeStats(this.species, this.level, this.ivs, this.evs);
    // Back-compat: legacy flat boosts from older saves (vitamins now grant EVs).
    if (set.statBonus) {
      for (const k of ['hp', 'atk', 'def', 'spa', 'spd', 'spe']) {
        if (set.statBonus[k]) this.stats[k] += set.statBonus[k];
      }
    }
    this.maxhp = this.stats.hp;
    this.hp = set.hp != null ? set.hp : this.maxhp;

    const moveIds = (set.moves && set.moves.length ? set.moves : dex.defaultMoves(set.species, this.level)).slice(0, 4);
    this.moveSlots = moveIds.map((id) => {
      const move = dex.getMove(id);
      return { id: toId(id), move, pp: move.pp, maxpp: move.pp };
    });

    this.status = set.status || null;        // 'brn'|'par'|'psn'|'tox'|'slp'|'frz'
    this.statusData = { sleepTurns: 0, toxicStage: 0 };
    this.resetBoostsAndVolatiles();
    this.fainted = this.hp <= 0;
    this.lastMove = null;
    this.lastMoveUsed = null;
    this.movedThisTurn = false;
    this.justSwitchedIn = true;
    this.participated = false; // set true once sent into battle (for EXP sharing)
  }

  resetBoostsAndVolatiles() {
    this.boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
    this.volatiles = {};
  }

  // Clear volatiles/boosts on switch out; status persists (Gen 2).
  onSwitchOut() {
    this.resetBoostsAndVolatiles();
    this.movedThisTurn = false;
    // Toxic reverts to regular poison damage counter reset in Gen 2 on switch.
    if (this.status === 'tox') this.statusData.toxicStage = 0;
  }

  isFainted() { return this.fainted || this.hp <= 0; }

  getMoveSlot(id) { return this.moveSlots.find((m) => m.id === toId(id)); }

  // Effective stat including stage boosts and status modifiers (par/brn).
  getStat(stat, { boosted = true, statusMod = true } = {}) {
    let value = this.stats[stat];
    if (boosted) value = Math.floor(value * statStageMultiplier(this.boosts[stat] || 0));
    if (statusMod) {
      if (stat === 'spe' && this.status === 'par') value = Math.floor(value / 4);
      if (stat === 'atk' && this.status === 'brn') value = Math.floor(value / 2);
    }
    return Math.max(1, value);
  }

  hpPercent() { return this.maxhp ? this.hp / this.maxhp : 0; }

  hasType(t) { return this.types.includes(t); }

  // Returns clamped damage actually dealt.
  damage(amount) {
    amount = Math.max(0, Math.floor(amount));
    const before = this.hp;
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp <= 0) this.fainted = true;
    return before - this.hp;
  }

  heal(amount) {
    amount = Math.max(0, Math.floor(amount));
    const before = this.hp;
    this.hp = Math.min(this.maxhp, this.hp + amount);
    return this.hp - before;
  }
}

// A player's side of the field.
export class Side {
  constructor(team, dex, name = 'Player') {
    this.dex = dex;
    this.name = name;
    this.team = team.map((set) => new Pokemon(set, dex));
    this.activeIndex = this.team.findIndex((p) => !p.isFainted());
    if (this.activeIndex < 0) this.activeIndex = 0;
    this.conditions = {}; // reflect, lightscreen, safeguard, spikes ...
    this.lastMove = null;
    this.wishOrFutureSight = null;
  }

  get active() { return this.team[this.activeIndex]; }

  aliveCount() { return this.team.filter((p) => !p.isFainted()).length; }

  hasAlive() { return this.aliveCount() > 0; }

  switchableIndices() {
    return this.team.map((p, i) => i).filter((i) => i !== this.activeIndex && !this.team[i].isFainted());
  }
}
