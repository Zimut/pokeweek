// Modern (Gen 3+) IV/EV stat calculation. IVs are 0-31 per stat (genetics); EVs
// are 0-252 per stat with a 510 total, contributing floor(EV/4). No natures.

export const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
export const MAX_IV = 31;
export const MAX_EV = 252;
export const EV_TOTAL_MAX = 510;
export const MAX_IVS = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
// "Average" genes for wild/trainer Pokémon (and a safe fallback).
export const DEFAULT_IVS = { hp: 15, atk: 15, def: 15, spa: 15, spd: 15, spe: 15 };
export const ZERO_EVS = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };

const clampIV = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(MAX_IV, v | 0)) : 15);
const evTerm = (v) => Math.floor(Math.max(0, Math.min(MAX_EV, v | 0)) / 4);

export function statHP(base, iv, evt, level) {
  return Math.floor(((2 * base + iv + evt) * level) / 100) + level + 10;
}
export function statOther(base, iv, evt, level) {
  return Math.floor(((2 * base + iv + evt) * level) / 100) + 5;
}

export function computeStats(species, level, ivs = DEFAULT_IVS, evs = ZERO_EVS) {
  const b = species.baseStats;
  const i = (k) => clampIV(ivs && ivs[k]);
  const e = (k) => evTerm(evs && evs[k]);
  return {
    hp: statHP(b.hp, i('hp'), e('hp'), level),
    atk: statOther(b.atk, i('atk'), e('atk'), level),
    def: statOther(b.def, i('def'), e('def'), level),
    spa: statOther(b.spa, i('spa'), e('spa'), level),
    spd: statOther(b.spd, i('spd'), e('spd'), level),
    spe: statOther(b.spe, i('spe'), e('spe'), level),
  };
}

// Gen-2 Hidden Power, derived from IV low bits — kept defined for the handful of
// species that learn the move naturally (it isn't sold as a TM).
const HP_TYPES = [
  'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel',
  'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark',
];
export function hiddenPower(ivs) {
  const a = clampIV(ivs && ivs.atk), d = clampIV(ivs && ivs.def);
  const s = clampIV(ivs && ivs.spe), c = clampIV(ivs && ivs.spa);
  const typeIndex = ((a & 0b0011) << 2) | (d & 0b0011);
  const v = (x, bit) => ((x >> bit) & 1);
  const msb = v(c, 3) + 2 * v(s, 3) + 4 * v(d, 3) + 8 * v(a, 3);
  const power = Math.floor((5 * msb + (c & 0b0011)) / 2) + 31;
  return { type: HP_TYPES[typeIndex], power };
}
