// Generates Gen 2 accurate pokedex / moves / typechart JSON from Pokemon Showdown.
//
// Showdown stores current (latest gen) data in data/*.ts and historical
// differences as per-generation mod overrides in data/mods/genN/*.ts. To
// reconstruct exact Gen 2 values we start from the base data and apply the
// mod overrides from the highest generation down to gen2, so gen2 wins.
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'src', 'data');
const TMP = join(os.tmpdir(), 'pokeweek-build');

const RAW = 'https://raw.githubusercontent.com/smogon/pokemon-showdown/master/data';
const GENS = [8, 7, 6, 5, 4, 3, 2]; // apply newest -> oldest so gen2 overrides win

// Gen 2 determined a move's physical/special split by its TYPE, not per-move.
const PHYSICAL_TYPES = new Set(['Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel']);
const SPECIAL_TYPES = new Set(['Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark']);

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.text();
}

// Showdown data files are TypeScript (`export const Name: Type = {...};`)
// and contain method definitions plus TS-only syntax. We write them to a temp
// .ts file and dynamic-import them: Node 24 strips the type annotations, the
// object (functions and all) loads, and JSON serialization later drops the
// non-data functions.
let tmpCounter = 0;
async function parseShowdown(text, tag) {
  await mkdir(TMP, { recursive: true });
  const file = join(TMP, `${tag}-${tmpCounter++}.ts`);
  await writeFile(file, text);
  const mod = await import(pathToFileURL(file).href);
  const key = Object.keys(mod).find((k) => k !== 'default') || 'default';
  return mod[key];
}

async function loadChain(file) {
  const tag = file.replace(/[^a-z0-9]/gi, '_');
  const base = await parseShowdown(await fetchText(`${RAW}/${file}`), `base_${tag}`);
  const result = structuredCloneSafe(base);
  for (const gen of GENS) {
    const text = await fetchText(`${RAW}/mods/gen${gen}/${file}`);
    if (!text) continue;
    const mod = await parseShowdown(text, `gen${gen}_${tag}`);
    for (const [key, override] of Object.entries(mod)) {
      const { inherit, ...fields } = override;
      if (result[key]) {
        Object.assign(result[key], fields); // overrides provide complete sub-objects
      } else {
        result[key] = fields;
      }
    }
    console.log(`  applied gen${gen}/${file} (${Object.keys(mod).length} overrides)`);
  }
  return result;
}

// Drop functions so we get a clean data-only structure.
function structuredCloneSafe(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function gen2Category(move) {
  if (move.category === 'Status' || (!move.basePower && move.basePower !== 0)) return move.category || 'Status';
  if (move.basePower === 0) return 'Status';
  if (PHYSICAL_TYPES.has(move.type)) return 'Physical';
  if (SPECIAL_TYPES.has(move.type)) return 'Special';
  return move.category || 'Physical';
}

async function buildPokedex() {
  console.log('Building pokedex...');
  const dex = await loadChain('pokedex.ts');
  const out = {};
  for (const [id, p] of Object.entries(dex)) {
    if (!(p.num >= 1 && p.num <= 251)) continue;
    if (p.forme || p.baseSpecies) continue; // skip alternate formes
    out[id] = {
      id,
      num: p.num,
      name: p.name,
      types: p.types,
      baseStats: p.baseStats,
      prevo: p.prevo || null,
      evos: p.evos || null,
      evoLevel: p.evoLevel || null,
      genderRatio: p.genderRatio || null,
    };
  }
  console.log(`  -> ${Object.keys(out).length} species`);
  return out;
}

async function buildMoves() {
  console.log('Building moves...');
  const moves = await loadChain('moves.ts');
  const passthrough = [
    'type', 'basePower', 'accuracy', 'pp', 'priority', 'flags', 'target',
    'secondary', 'secondaries', 'self', 'boosts', 'status', 'volatileStatus',
    'drain', 'recoil', 'heal', 'critRatio', 'multihit', 'multiaccuracy',
    'ohko', 'thawsTarget', 'forceSwitch', 'selfdestruct', 'breaksProtect',
    'ignoreImmunity', 'sleepUsable', 'stallingMove', 'willCrit', 'noFaint',
    'sideCondition', 'slotCondition', 'weather', 'pseudoWeather',
    'nonGhostTarget', 'overrideOffensiveStat', 'sleepEffect',
  ];
  const out = {};
  for (const [id, m] of Object.entries(moves)) {
    if (!(m.num >= 1 && m.num <= 251)) continue; // Gen 2 = moves #1-251
    // Showdown splits Hidden Power into per-type variants; Gen 2 derives its
    // type/power from DVs at runtime, so keep only the base "hiddenpower".
    if (id.startsWith('hiddenpower') && id !== 'hiddenpower') continue;
    const move = { id, num: m.num, name: m.name, category: gen2Category(m) };
    for (const key of passthrough) {
      if (m[key] !== undefined) move[key] = m[key];
    }
    out[id] = move;
  }
  console.log(`  -> ${Object.keys(out).length} moves`);
  return out;
}

async function buildTypechart() {
  console.log('Building typechart...');
  const chart = await loadChain('typechart.ts');
  // Showdown damageTaken codes: 0 = neutral, 1 = super effective (2x),
  // 2 = resisted (0.5x), 3 = immune (0x).
  const code2mult = { 0: 1, 1: 2, 2: 0.5, 3: 0 };
  // Exclude types that do not exist in Gen 2.
  const EXCLUDE = new Set(['fairy', 'stellar', '???']);
  const types = Object.keys(chart)
    .filter((k) => !EXCLUDE.has(k) && chart[k].damageTaken)
    .map(capitalize);

  const out = { types, table: {} };
  for (const t of types) out.table[t] = {};
  for (const [defKeyRaw, info] of Object.entries(chart)) {
    const defType = capitalize(defKeyRaw);
    if (defType === 'Fairy' || !info.damageTaken) continue;
    for (const [atkType, code] of Object.entries(info.damageTaken)) {
      if (atkType === 'Fairy') continue;
      if (!types.includes(atkType)) continue;
      const mult = code2mult[code];
      if (mult === undefined) continue;
      out.table[atkType][defType] = mult;
    }
  }
  console.log(`  -> ${types.length} types`);
  return out;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const [pokedex, movesData, typechart] = [await buildPokedex(), await buildMoves(), await buildTypechart()];
  await writeFile(join(OUT, 'pokedex.json'), JSON.stringify(pokedex));
  await writeFile(join(OUT, 'moves.json'), JSON.stringify(movesData));
  await writeFile(join(OUT, 'typechart.json'), JSON.stringify(typechart));
  console.log('Wrote pokedex.json, moves.json, typechart.json to src/data/');
}

main().catch((e) => { console.error(e); process.exit(1); });
