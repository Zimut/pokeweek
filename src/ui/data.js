// Browser-side data layer: fetches the generated Gen 2 JSON and builds a Dex.
import { Dex } from '../engine/dex.js';
export { TYPE_COLORS, STATUS, STATUS_SHORT } from '../engine/constants.js';

const DATA = 'src/data';

export async function loadDex() {
  const files = ['pokedex', 'moves', 'typechart', 'learnsets'];
  const [pokedex, moves, typechart, learnsets] = await Promise.all(
    files.map((f) => fetch(`${DATA}/${f}.json`).then((r) => {
      if (!r.ok) throw new Error(`Failed to load ${f}.json (${r.status})`);
      return r.json();
    })),
  );
  return new Dex({ pokedex, moves, typechart, learnsets });
}

// National-dex-number sprites downloaded under /assets/sprites/{front,back}.
export const spriteFront = (num, shiny = false) => `assets/sprites/front/${shiny ? 'shiny/' : ''}${num}.png`;
export const spriteBack = (num, shiny = false) => `assets/sprites/back/${shiny ? 'shiny/' : ''}${num}.png`;

// Battle-EXP curve. `expToNext(level)` is the experience needed to advance from
// `level` to the next; `expFraction(mon)` is a mon's 0–1 progress toward its
// next level (for the team-panel EXP bar). Shared by the game logic that grants
// EXP and the overworld that draws the bar.
export const expToNext = (level) => 12 + Math.round((level || 1) * 8);
export function expFraction(mon) {
  if (!mon) return 0;
  const need = expToNext(mon.level || 1);
  return need > 0 ? Math.max(0, Math.min(1, (mon.exp || 0) / need)) : 0;
}
