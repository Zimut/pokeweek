// Read-only data access layer. Constructed from the generated JSON so the
// engine itself stays free of any I/O (works in browser and Node alike).
export class Dex {
  constructor({ pokedex, moves, typechart, learnsets }) {
    this.pokedex = pokedex;
    this.moves = moves;
    this.typechart = typechart; // { types: [...], table: { atk: { def: mult } } }
    this.learnsets = learnsets;
    this._speciesByNum = Object.values(pokedex).sort((a, b) => a.num - b.num);
  }

  getSpecies(id) {
    const s = this.pokedex[toId(id)];
    if (!s) throw new Error('Unknown species: ' + id);
    return s;
  }
  getMove(id) {
    const m = this.moves[toId(id)];
    if (!m) throw new Error('Unknown move: ' + id);
    return m;
  }
  getLearnset(id) {
    return this.learnsets[toId(id)] || { num: 0, levelup: [], machine: [] };
  }
  allSpecies() { return this._speciesByNum; }

  // Multiplier of a single attacking type vs a single defending type.
  typeMult(atkType, defType) {
    const row = this.typechart.table[atkType];
    if (!row) return 1;
    const v = row[defType];
    return v === undefined ? 1 : v;
  }

  // Combined effectiveness of an attacking type vs a (1-2 type) defender.
  effectiveness(atkType, defenderTypes) {
    let mult = 1;
    for (const t of defenderTypes) mult *= this.typeMult(atkType, t);
    return mult;
  }

  // Moves a species can legally have at a given level (level-up <= level, plus
  // all TM/HM machine moves; no breeding/tutor — matches PokeWeek house rules).
  legalMoves(speciesId, level) {
    const ls = this.getLearnset(speciesId);
    const set = new Set();
    for (const e of ls.levelup) if (e.level <= level) set.add(e.move);
    for (const m of ls.machine) set.add(m);
    return [...set].filter((m) => this.moves[m]);
  }

  // The most recent 4 level-up moves at/under a level (a sensible default set).
  defaultMoves(speciesId, level) {
    const ls = this.getLearnset(speciesId);
    const learned = ls.levelup.filter((e) => e.level <= level).map((e) => e.move);
    const unique = [...new Set(learned)];
    return unique.slice(-4);
  }
}

export function toId(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}
