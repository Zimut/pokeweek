// Gen 2 battle constants & lookup tables.

// In Gen 2 a move's physical/special split is determined by its TYPE.
export const PHYSICAL_TYPES = new Set(['Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel']);
export const SPECIAL_TYPES = new Set(['Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark']);

export const STATUS = {
  brn: 'Burn', par: 'Paralysis', psn: 'Poison', tox: 'Badly Poisoned', slp: 'Sleep', frz: 'Freeze',
};
export const STATUS_SHORT = { brn: 'BRN', par: 'PAR', psn: 'PSN', tox: 'PSN', slp: 'SLP', frz: 'FRZ' };

// Type colours for UI (classic GSC-ish palette).
export const TYPE_COLORS = {
  Normal: '#a8a878', Fire: '#f08030', Water: '#6890f0', Electric: '#f8d030',
  Grass: '#78c850', Ice: '#98d8d8', Fighting: '#c03028', Poison: '#a040a0',
  Ground: '#e0c068', Flying: '#a890f0', Psychic: '#f85888', Bug: '#a8b820',
  Rock: '#b8a038', Ghost: '#705898', Dragon: '#7038f8', Dark: '#705848',
  Steel: '#b8b8d0',
};

// Regular stat-stage multipliers (atk/def/spa/spd/spe). Same across Gens 1-8.
export function statStageMultiplier(stage) {
  stage = Math.max(-6, Math.min(6, stage));
  return stage >= 0 ? (2 + stage) / 2 : 2 / (2 - stage);
}

// Accuracy/evasion stage multipliers. (Gen 2's table is very close to this;
// using the well-documented fractional table.)
const ACC_TABLE = {
  '-6': 33 / 100, '-5': 36 / 100, '-4': 43 / 100, '-3': 50 / 100, '-2': 60 / 100,
  '-1': 75 / 100, '0': 1, '1': 133 / 100, '2': 166 / 100, '3': 2, '4': 233 / 100,
  '5': 266 / 100, '6': 3,
};
export function accStageMultiplier(stage) {
  stage = Math.max(-6, Math.min(6, stage));
  return ACC_TABLE[String(stage)];
}

// Gen 2 critical-hit probabilities by crit stage (out of 256).
export const CRIT_CHANCE = { 0: 17 / 256, 1: 1 / 8, 2: 1 / 4, 3: 85 / 256, 4: 1 / 2 };
export function critChance(stage) {
  return CRIT_CHANCE[Math.max(0, Math.min(4, stage))];
}

export const BOOSTABLE = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'];
export const STAT_NAMES = {
  atk: 'Attack', def: 'Defense', spa: 'Sp. Atk', spd: 'Sp. Def', spe: 'Speed',
  accuracy: 'accuracy', evasion: 'evasiveness',
};
