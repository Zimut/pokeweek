// Generates the PokeWeek "full game" world content into src/data/world/ from
// compact curated source data + the engine's own move logic. Re-runnable and
// deterministic. Emits: progression.json, maps.json, encounters.json,
// trainers.json, gyms.json, mart.json, evolution.json — then validates them.
//
// Run with:  npm run build:world
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Dex, toId } from '../src/engine/dex.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA = join(ROOT, 'src', 'data');
const OUT = join(DATA, 'world');
mkdirSync(OUT, { recursive: true });

const readJson = (p) => JSON.parse(readFileSync(join(DATA, p), 'utf8'));
const pokedex = readJson('pokedex.json');
const moves = readJson('moves.json');
const typechart = readJson('typechart.json');
const learnsets = readJson('learnsets.json');
const dex = new Dex({ pokedex, moves, typechart, learnsets });

const byNum = {};
for (const s of Object.values(pokedex)) byNum[s.num] = s;
const inDex = (name) => !!pokedex[toId(name)];
const idOf = (num) => byNum[num].id;
const LEGENDARIES = new Set([144, 145, 146, 150, 151, 243, 244, 245, 249, 250, 251]);

// Catchable first-stage = no in-dex prevo, not legendary. (Babies like Pichu,
// and Gen-2 mons whose only prevo is a non-Gen2 baby like Marill, count.)
const CATCHABLE = Object.values(pokedex)
  .filter((s) => (!s.prevo || !inDex(s.prevo)) && !LEGENDARIES.has(s.num))
  .map((s) => s.num)
  .sort((a, b) => a - b);

// Deterministic RNG (mulberry32) so regenerating is stable.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rand, arr) => arr[Math.floor(rand() * arr.length)];
const randint = (rand, lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

// ---------------------------------------------------------------------------
// 1) PROGRESSION (global config + per-map bands/caps/gym pairing)
// ---------------------------------------------------------------------------
const MAPS = [
  { map: 1, band: [3, 7],   cap: 15, gymLevel: 10, kanto: 'Brock',     johto: 'Falkner', theme: 'meadow' },
  { map: 2, band: [8, 12],  cap: 21, gymLevel: 16, kanto: 'Misty',     johto: 'Bugsy',   theme: 'forest' },
  { map: 3, band: [13, 18], cap: 27, gymLevel: 22, kanto: 'Lt. Surge', johto: 'Whitney', theme: 'cave'   },
  { map: 4, band: [18, 24], cap: 33, gymLevel: 28, kanto: 'Erika',     johto: 'Morty',   theme: 'coast'  },
  { map: 5, band: [24, 30], cap: 39, gymLevel: 34, kanto: 'Sabrina',   johto: 'Jasmine', theme: 'plain'  },
  { map: 6, band: [30, 36], cap: 45, gymLevel: 40, kanto: 'Blaine',    johto: 'Pryce',   theme: 'mountain' },
  { map: 7, band: [36, 44], cap: 52, gymLevel: 48, kanto: 'Giovanni',  johto: 'Clair',   theme: 'plateau' },
];

// The 8th map is the tournament arena: no bands/gyms, a high level cap so the
// championship is fought on (nearly) full teams.
const ARENA = { map: 8, cap: 55, theme: 'arena' };

const progression = {
  mapCount: 7,
  arenaMap: 8,
  weekDays: 7,                    // a 1-week game = one day per route (Task 18)
  startMoney: 0,
  teamSize: 6,
  rewards: { trainer: 200, gym: 1000, pvpWin: 1000, pvpLose: -1000, dailyPenalty: -2000 },
  ballOptions: [10, 25, 50, 100, 'infinite'],
  dayDefaultMs: 24 * 60 * 60 * 1000,
  starters: ['bulbasaur', 'charmander', 'squirtle', 'chikorita', 'cyndaquil', 'totodile'],
  shinyRate: 300,                 // 1 in 300 wild encounters
  encounterStepRate: 0.12,        // ~12% per grass step (doubled wild encounter rate)
  // base per-throw catch probability by rarity (before HP/status/ball mults)
  catchBaseByRarity: { common: 0.45, uncommon: 0.30, rare: 0.18, veryrare: 0.10 },
  ballMult: { pokeball: 1, greatball: 5 },
  maps: [
    ...MAPS.map((m) => ({ map: m.map, band: m.band, cap: m.cap, gymLevel: m.gymLevel, kanto: m.kanto, johto: m.johto, theme: m.theme })),
    { map: ARENA.map, cap: ARENA.cap, theme: ARENA.theme },
  ],
};

// ---------------------------------------------------------------------------
// 2) MAPS (single-screen tile grids; identical geometry, per-map theme)
// ---------------------------------------------------------------------------
// Tile codes: '#' wall  '.' floor  'G' grass  'T' trainer  'M' mart door
//             'K' Kanto gym door  'J' Johto gym door  'N' north exit  'S' spawn
//             'B' building body (solid; the door tile keeps its M/K/J code)
const W = 21, H = 15;
function buildMapGeometry() {
  const grid = Array.from({ length: H }, () => Array.from({ length: W }, () => '.'));
  for (let x = 0; x < W; x++) { grid[0][x] = '#'; grid[H - 1][x] = '#'; }
  for (let y = 0; y < H; y++) { grid[y][0] = '#'; grid[y][W - 1] = '#'; }
  const cx = 10;
  grid[0][cx] = 'N';          // north exit gap
  grid[H - 1][cx] = 'S';      // south entrance gap
  // Buildings occupy a 3x3 footprint of solid 'B' tiles; the door is the
  // bottom-center tile (approached from below) and keeps its M/K/J code so the
  // overworld can anchor the building sprite there and trigger its interaction.
  const gymK = { x: 2, y: 2 }, gymJ = { x: W - 3, y: 2 }, martD = { x: cx, y: 11 };
  const stampBuilding = (door, code) => {
    for (let yy = door.y - 2; yy <= door.y; yy++)
      for (let xx = door.x - 1; xx <= door.x + 1; xx++)
        if (yy >= 0 && yy < H && xx >= 0 && xx < W) grid[yy][xx] = 'B';
    grid[door.y][door.x] = code;
  };
  stampBuilding(gymK, 'K');   // Kanto gym (top-left)
  stampBuilding(gymJ, 'J');   // Johto gym (top-right)
  stampBuilding(martD, 'M');  // Poké Mart (center)
  // central grass patch (5x5, ~2x the old 3x4 — more steps between wild battles)
  const grass = [];
  for (let y = 4; y <= 8; y++) for (let x = 8; x <= 12; x++) { grid[y][x] = 'G'; grass.push({ x, y }); }
  // two trainer columns of 10 (left col 3, right col 17), rows 4..13
  const trainers = [];
  for (let i = 0; i < 10; i++) {
    const y = 4 + i;
    grid[y][3] = 'T'; trainers.push({ id: i, x: 3, y, facing: 'right' });
    grid[y][17] = 'T'; trainers.push({ id: 10 + i, x: 17, y, facing: 'left' });
  }
  return {
    width: W, height: H,
    tiles: grid.map((r) => r.join('')),
    spawn: { x: cx, y: H - 2 },
    north: { x: cx, y: 0 },
    mart: { x: martD.x, y: martD.y },
    gyms: { kanto: { x: gymK.x, y: gymK.y }, johto: { x: gymJ.x, y: gymJ.y } },
    trainers,
    grass,
  };
}
const geometry = buildMapGeometry();
const mapsOut = MAPS.map((m) => ({ map: m.map, theme: m.theme, ...geometry }));

// The tournament arena (map 8): a single empty hall — no grass, trainers, mart
// or gyms. Four pillars frame a central stage; players spawn at the south gap.
function buildArenaGeometry() {
  const grid = Array.from({ length: H }, () => Array.from({ length: W }, () => '.'));
  for (let x = 0; x < W; x++) { grid[0][x] = '#'; grid[H - 1][x] = '#'; }
  for (let y = 0; y < H; y++) { grid[y][0] = '#'; grid[y][W - 1] = '#'; }
  const cx = 10;
  grid[H - 1][cx] = 'S';                       // south entrance gap
  for (const [px, py] of [[5, 4], [15, 4], [5, 10], [15, 10]]) grid[py][px] = '#'; // pillars
  return {
    width: W, height: H,
    tiles: grid.map((r) => r.join('')),
    spawn: { x: cx, y: H - 2 },
    trainers: [], grass: [],
  };
}
mapsOut.push({ map: ARENA.map, theme: ARENA.theme, ...buildArenaGeometry() });

// ---------------------------------------------------------------------------
// 3) ENCOUNTERS (every catchable base form placed on exactly one map)
// ---------------------------------------------------------------------------
const MAP_MONS = {
  1: [16, 19, 10, 13, 21, 161, 163, 165, 167, 187, 191, 194, 172, 173, 174, 179, 183],
  2: [43, 69, 41, 46, 48, 23, 27, 29, 32, 56, 52, 54, 60, 177, 209, 175, 152],
  3: [63, 66, 74, 50, 81, 100, 88, 109, 92, 96, 37, 58, 77, 218, 228, 155, 190],
  4: [72, 98, 90, 120, 118, 86, 116, 170, 223, 211, 222, 129, 7, 158, 226, 225],
  5: [102, 114, 108, 84, 83, 122, 203, 206, 234, 241, 128, 115, 1, 185, 193, 235, 201],
  6: [104, 111, 95, 220, 215, 198, 200, 207, 227, 231, 216, 204, 214, 213, 4, 240, 239],
  7: [246, 147, 131, 133, 137, 123, 127, 138, 140, 142, 113, 143, 238, 236, 132, 79, 202],
};
const VERYRARE = new Set([1, 4, 7, 152, 155, 158, 201, 132]);
const RARE = new Set([172, 173, 174, 175, 183, 147, 246, 133, 131, 137, 142, 138, 140, 113, 143,
  123, 127, 214, 227, 215, 241, 115, 128, 226, 225, 238, 240, 239, 236, 202, 213, 122, 185]);
const COMMON = new Set([16, 19, 10, 13, 21, 161, 163, 165, 167, 187, 191, 194, 179, 41, 43, 69,
  23, 27, 52, 54, 56, 60, 74, 50, 100, 88, 92, 72, 98, 118, 129]);
const RARITY_WEIGHT = { common: 40, uncommon: 20, rare: 8, veryrare: 3 };
function rarityOf(num) {
  if (VERYRARE.has(num)) return 'veryrare';
  if (RARE.has(num)) return 'rare';
  if (COMMON.has(num)) return 'common';
  return 'uncommon';
}
const encounters = {};
for (const m of MAPS) {
  const band = m.band;
  const list = MAP_MONS[m.map].map((num) => {
    const rarity = rarityOf(num);
    return { num, species: idOf(num), name: byNum[num].name, rarity, weight: RARITY_WEIGHT[rarity], min: band[0], max: band[1] };
  });
  encounters[m.map] = list;
}
encounters[ARENA.map] = []; // the arena has no wild grass

// ---------------------------------------------------------------------------
// 4) EVOLUTION (level from evoLevel; curated stone/trade; Eevee stone-only)
// ---------------------------------------------------------------------------
const STONE = {
  // base species id : [ [stone, evoSpeciesId], ... ]
  pikachu: [['thunderstone', 'raichu']],
  vulpix: [['firestone', 'ninetales']],
  growlithe: [['firestone', 'arcanine']],
  clefairy: [['moonstone', 'clefable']],
  jigglypuff: [['moonstone', 'wigglytuff']],
  nidorina: [['moonstone', 'nidoqueen']],
  nidorino: [['moonstone', 'nidoking']],
  gloom: [['leafstone', 'vileplume'], ['sunstone', 'bellossom']],
  weepinbell: [['leafstone', 'victreebel']],
  exeggcute: [['leafstone', 'exeggutor']],
  poliwhirl: [['waterstone', 'poliwrath']],
  shellder: [['waterstone', 'cloyster']],
  staryu: [['waterstone', 'starmie']],
  eevee: [['waterstone', 'vaporeon'], ['thunderstone', 'jolteon'], ['firestone', 'flareon']],
  sunkern: [['sunstone', 'sunflora']],
  slowpoke: [['waterstone', 'slowking']], // Slowbro is the level path (auto, L37)
};
// Trade / friendship / trade-item evolutions reassigned a level.
const TRADE_LEVEL = {
  alakazam: 37, machamp: 37, golem: 37, gengar: 37, steelix: 30, scizor: 35,
  kingdra: 42, politoed: 37, porygon2: 30, blissey: 30, crobat: 36,
  pikachu: 8, clefairy: 8, jigglypuff: 8, togetic: 8, // babies via friendship (low level)
};
// Removed entirely (no Gen-2 eeveelutions in PokeWeek).
const REMOVED = new Set(['espeon', 'umbreon']);

const evolution = {};
for (const s of Object.values(pokedex)) {
  const from = s.id;
  const entries = [];
  // stones
  if (STONE[from]) for (const [stone, evo] of STONE[from]) {
    if (inDex(evo) && !REMOVED.has(toId(evo))) entries.push({ to: toId(evo), method: 'stone', item: stone });
  }
  // level / trade-as-level
  for (const e of (s.evos || [])) {
    const eid = toId(e);
    if (!inDex(e) || REMOVED.has(eid)) continue;
    const child = pokedex[eid];
    // skip ones already covered as a stone evo of this base
    if (STONE[from] && STONE[from].some(([, evo]) => toId(evo) === eid)) continue;
    if (child.evoLevel != null) entries.push({ to: eid, method: 'level', level: child.evoLevel });
    else if (TRADE_LEVEL[eid] != null) entries.push({ to: eid, method: 'level', level: TRADE_LEVEL[eid] });
    // else: unclassified branch left out (none expected after curation)
  }
  if (entries.length) evolution[from] = entries;
}

// Helper: evolve a base species to the form it would naturally be at `level`
// (follows LEVEL evolutions only; stones/trade-levels happen via items/leveling
// in play, but trainers/wild use level chains for realism).
function evolveTo(speciesId, level) {
  let cur = toId(speciesId);
  for (let guard = 0; guard < 3; guard++) {
    const evos = (evolution[cur] || []).filter((e) => e.method === 'level' && e.level <= level);
    if (!evos.length) break;
    evos.sort((a, b) => a.level - b.level);
    cur = evos[0].to;
  }
  return cur;
}

// ---------------------------------------------------------------------------
// EV tuning: enemies gather EVs as if they'd battled through their life, so a
// higher-level Pokémon carries more. Trainers spread EVs broadly; gyms focus
// them on the stats that matter for each Pokémon. (IVs stay a flat median of 15,
// applied at battle time.) Engine rules: ≤252 per stat, ≤510 total.
const EV_STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const evBudgetForLevel = (level) => Math.min(510, Math.round(level * 7));

function clampEvs(evs) {
  for (const k of EV_STATS) evs[k] = Math.max(0, Math.min(252, Math.round(evs[k] || 0)));
  let total = EV_STATS.reduce((s, k) => s + evs[k], 0);
  while (total > 510) {
    const k = EV_STATS.reduce((a, b) => (evs[b] > evs[a] ? b : a), EV_STATS[0]);
    const cut = Math.min(evs[k], total - 510);
    evs[k] -= cut; total -= cut;
  }
  return evs;
}

// Trainers: spread the level's EV budget across all six stats with seeded jitter.
function trainerEvs(level, rand) {
  const budget = evBudgetForLevel(level);
  const weights = EV_STATS.map(() => 0.5 + rand());
  const sum = weights.reduce((a, b) => a + b, 0);
  const evs = {};
  EV_STATS.forEach((k, i) => { evs[k] = Math.round((weights[i] / sum) * budget); });
  return clampEvs(evs);
}

// Gyms: focus the budget on the Pokémon's attacking stat plus its best supporting
// stats, so each leader's mon plays to its strengths.
function gymEvs(speciesId, level) {
  const base = pokedex[toId(speciesId)].baseStats;
  const evs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  let budget = evBudgetForLevel(level);
  const atkStat = (base.atk >= base.spa) ? 'atk' : 'spa';
  // support = the highest-base of hp/def/spd/spe (never the unused attack stat)
  const support = ['hp', 'def', 'spd', 'spe'].sort((a, b) => base[b] - base[a]);
  for (const k of [atkStat, support[0], support[1], support[2]]) {
    if (budget <= 0) break;
    const put = Math.min(252, budget);
    evs[k] += put; budget -= put;
  }
  return clampEvs(evs);
}

// ---------------------------------------------------------------------------
// 5) TRAINERS (20 per map, themed classes, parties that ramp in difficulty)
// ---------------------------------------------------------------------------
// The two trainer columns run rows 4 (top) .. 13 (bottom). We turn each
// trainer's column position into a difficulty rank — 0 at the bottom (easiest),
// 9 at the top (hardest) — and scale party size, levels and reward by it:
//   * bottom third (rank 0-2): a single weak mon near the route's band floor;
//   * middle (rank 3-6): two mons climbing toward the cap;
//   * top third (rank 7-9): three strong mons whose ace sits just under the
//     level cap — above the local gym leader, so the top trainers out-muscle it.
// Size/levels are a deterministic function of rank (guaranteeing a monotonic
// ramp); only species choice stays RNG-seeded so parties still vary per map.
const CLASS_BY_MAP = {
  1: ['Youngster', 'Lass', 'Bug Catcher', 'Picnicker'],
  2: ['Bug Catcher', 'Camper', 'Youngster', 'Lass', 'Twins'],
  3: ['Hiker', 'Super Nerd', 'Engineer', 'Firebreather', 'Camper'],
  4: ['Swimmer', 'Sailor', 'Fisher', 'Lass', 'Beauty'],
  5: ['Psychic', 'Pokémaniac', 'Bird Keeper', 'Lass', 'Schoolboy'],
  6: ['Hiker', 'Skier', 'Blackbelt', 'Birdkeeper', 'Pokémaniac'],
  7: ['Cooltrainer', 'Veteran', 'Ace Trainer', 'Dragon Tamer'],
};
const NAMES = ['Joey', 'Mikey', 'Anna', 'Liz', 'Sam', 'Kai', 'Bret', 'Tess', 'Dale', 'Nina',
  'Owen', 'Rita', 'Gus', 'Vera', 'Theo', 'Mona', 'Cody', 'Iris', 'Hank', 'Zoe', 'Pete', 'Lana'];

const trainers = {};
for (const m of MAPS) {
  const rand = rng(1000 + m.map);
  const pool = MAP_MONS[m.map];
  const list = [];
  for (let i = 0; i < 20; i++) {
    // Column position → difficulty rank: ids 0-9 (left) and 10-19 (right) both
    // sit on rows 4..13, so id%10 is the row offset (0 = top). Flip it so the
    // bottom of the column is the easiest (rank 0) and the top is hardest (9).
    const rank = 9 - (i % 10);
    const cls = CLASS_BY_MAP[m.map][i % CLASS_BY_MAP[m.map].length];
    const name = NAMES[(i + m.map * 3) % NAMES.length];
    // Party grows 1 → 2 → 3 across the column; the ace level scales from the
    // band floor up to one below the cap, so top trainers eclipse the gym.
    const size = rank <= 2 ? 1 : rank <= 6 ? 2 : 3;
    const ace = Math.min(m.cap - 1, Math.round(m.band[0] + (m.cap - 1 - m.band[0]) * (rank / 9)));
    const party = [];
    for (let k = 0; k < size; k++) {
      // Members escalate toward the ace in the last slot, ~1 level apart.
      const level = Math.max(5, Math.min(m.cap - 1, ace - (size - 1 - k)));
      const baseNum = pick(rand, pool);
      const species = evolveTo(idOf(baseNum), level);
      party.push({ species, level, moves: dex.defaultMoves(species, level), evs: trainerEvs(level, rand) });
    }
    const reward = Math.round(progression.rewards.trainer * (1 + 0.25 * rank));
    list.push({ id: i, class: cls, name, rank, reward, party });
  }
  trainers[m.map] = list;
}
trainers[ARENA.map] = []; // the arena has no overworld trainers

// ---------------------------------------------------------------------------
// 6) GYMS (14 hand-authored type-themed leaders; ace last)
// ---------------------------------------------------------------------------
const GYM_TEAMS = {
  Brock:       [['geodude', 9], ['onix', 11]],
  Falkner:     [['pidgey', 7], ['pidgeotto', 9]],
  Misty:       [['goldeen', 16], ['staryu', 18]],
  Bugsy:       [['metapod', 15], ['kakuna', 15], ['scyther', 17]],
  'Lt. Surge': [['voltorb', 21], ['pikachu', 22], ['magnemite', 24]],
  Whitney:     [['clefairy', 22], ['miltank', 24]],
  Erika:       [['gloom', 28], ['weepinbell', 28], ['tangela', 30]],
  Morty:       [['gastly', 26], ['haunter', 28], ['misdreavus', 30]],
  Sabrina:     [['kadabra', 34], ['hypno', 34], ['mrmime', 36]],
  Jasmine:     [['magneton', 34], ['steelix', 35], ['skarmory', 36]],
  Blaine:      [['magmar', 40], ['rapidash', 40], ['arcanine', 42]],
  Pryce:       [['dewgong', 40], ['piloswine', 40], ['lapras', 42]],
  Giovanni:    [['dugtrio', 46], ['nidoking', 48], ['rhydon', 49]],
  Clair:       [['gyarados', 47], ['dragonair', 48], ['kingdra', 50]],
};
// Gym leaders' Pokémon are ALL set to the map's level cap (the route's "Max Lv"),
// evolved to their natural form for that level, with EVs focused on each mon's
// strengths — making every gym a full-strength boss fight.
const gyms = {};
for (const m of MAPS) {
  const build = (leader, type, region) => {
    const lvl = m.cap;
    const team = GYM_TEAMS[leader].map(([species]) => {
      const sp = evolveTo(species, lvl);
      return { species: sp, level: lvl, moves: dex.defaultMoves(sp, lvl), evs: gymEvs(sp, lvl) };
    });
    return { leader, region, gymType: type, reward: progression.rewards.gym, team };
  };
  const GTYPE = {
    Brock: 'Rock', Falkner: 'Flying', Misty: 'Water', Bugsy: 'Bug', 'Lt. Surge': 'Electric',
    Whitney: 'Normal', Erika: 'Grass', Morty: 'Ghost', Sabrina: 'Psychic', Jasmine: 'Steel',
    Blaine: 'Fire', Pryce: 'Ice', Giovanni: 'Ground', Clair: 'Dragon',
  };
  gyms[m.map] = {
    kanto: build(m.kanto, GTYPE[m.kanto], 'Kanto'),
    johto: build(m.johto, GTYPE[m.johto], 'Johto'),
  };
}

// Per-route max level (shown on the overworld HUD) = the highest level present
// on any of the route's trainers or gym leaders. Patched onto progression.maps.
for (const m of MAPS) {
  let maxLv = 0;
  for (const t of trainers[m.map]) for (const s of t.party) maxLv = Math.max(maxLv, s.level);
  for (const side of ['kanto', 'johto']) for (const s of gyms[m.map][side].team) maxLv = Math.max(maxLv, s.level);
  const pe = progression.maps.find((p) => p.map === m.map);
  if (pe) pe.maxLevel = maxLv;
}
// The arena has no trainers/gyms; its "max level" is simply its level cap.
{ const ae = progression.maps.find((p) => p.map === ARENA.map); if (ae) ae.maxLevel = ARENA.cap; }

// ---------------------------------------------------------------------------
// 7) MART (full catalog available on every map; prices from design doc)
// ---------------------------------------------------------------------------
const BASE_ITEMS = [
  { id: 'greatball', name: 'Great Ball', kind: 'ball', price: 500, mult: 5 },
  { id: 'rarecandy', name: 'Rare Candy', kind: 'levelup', price: 2000 },
  { id: 'hpup', name: 'HP Up', kind: 'statboost', stat: 'hp', price: 1000 },
  { id: 'protein', name: 'Protein', kind: 'statboost', stat: 'atk', price: 1000 },
  { id: 'iron', name: 'Iron', kind: 'statboost', stat: 'def', price: 1000 },
  { id: 'calcium', name: 'Calcium', kind: 'statboost', stat: 'spa', price: 1000 },
  { id: 'zinc', name: 'Zinc', kind: 'statboost', stat: 'spd', price: 1000 },
  { id: 'carbos', name: 'Carbos', kind: 'statboost', stat: 'spe', price: 1000 },
  { id: 'firestone', name: 'Fire Stone', kind: 'stone', price: 2000 },
  { id: 'waterstone', name: 'Water Stone', kind: 'stone', price: 2000 },
  { id: 'thunderstone', name: 'Thunder Stone', kind: 'stone', price: 2000 },
  { id: 'leafstone', name: 'Leaf Stone', kind: 'stone', price: 2000 },
  { id: 'moonstone', name: 'Moon Stone', kind: 'stone', price: 2000 },
  { id: 'sunstone', name: 'Sun Stone', kind: 'stone', price: 2000 },
];

// A curated set of 20 iconic Gen-2 TMs, spread across types (no HMs are sold).
// [TM number, move id]; the number is kept authentic for the item name. Each
// teaches its move to a Pokémon whose `machine` learnset contains it.
const TM_LIST = [
  [1, 'dynamicpunch'], [6, 'toxic'], [14, 'blizzard'], [15, 'hyperbeam'], [22, 'solarbeam'],
  [23, 'irontail'], [24, 'dragonbreath'], [25, 'thunder'], [26, 'earthquake'], [27, 'return'],
  [29, 'psychic'], [30, 'shadowball'], [32, 'doubleteam'], [35, 'sleeptalk'], [36, 'sludgebomb'],
  [37, 'sandstorm'], [38, 'fireblast'], [44, 'rest'], [45, 'attract'], [46, 'thief'],
];
const pad2 = (n) => String(n).padStart(2, '0');
const TM_ITEMS = [];
for (const [n, mv] of TM_LIST) {
  const mdef = moves[toId(mv)];
  if (!mdef) { console.warn(`Mart: TM${n} move "${mv}" missing from dex — skipped`); continue; }
  TM_ITEMS.push({ id: `tm${n}`, name: `TM${pad2(n)} ${mdef.name}`, kind: 'tm', move: toId(mv), price: 2000 });
}

// Every map's mart sells the full catalog — players can see and buy everything.
const MART_ITEMS = [...BASE_ITEMS, ...TM_ITEMS];
const mart = {};
for (const m of MAPS) mart[m.map] = MART_ITEMS.map((it) => ({ ...it }));
gyms[ARENA.map] = {}; // the arena has no gym leaders
mart[ARENA.map] = []; // the arena has no mart

// ---------------------------------------------------------------------------
// VALIDATION
// ---------------------------------------------------------------------------
const errors = [];
const assert = (cond, msg) => { if (!cond) errors.push(msg); };

// coverage: every catchable base form on exactly one map
const placed = new Map();
for (const m of MAPS) for (const num of MAP_MONS[m.map]) {
  if (placed.has(num)) errors.push(`#${num} placed on maps ${placed.get(num)} AND ${m.map}`);
  placed.set(num, m.map);
}
for (const num of CATCHABLE) assert(placed.has(num), `catchable #${num} ${byNum[num].name} is on no map`);
for (const num of placed.keys()) assert(CATCHABLE.includes(num), `#${num} placed but not catchable/base`);

// every set references valid species + has ≥1 legal move
function checkSet(s, where) {
  assert(!!pokedex[toId(s.species)], `${where}: unknown species ${s.species}`);
  assert(s.level >= 2 && s.level <= 100, `${where}: bad level ${s.level} for ${s.species}`);
  const legal = new Set(dex.legalMoves(s.species, s.level));
  const ms = (s.moves || []).filter((mm) => legal.has(mm));
  assert(ms.length >= 1, `${where}: ${s.species} L${s.level} has no legal moves (${(s.moves || []).join(',')})`);
}
for (const m of MAPS) {
  for (const t of trainers[m.map]) { assert(t.party.length >= 1, `map${m.map} trainer ${t.id} empty`); for (const s of t.party) checkSet(s, `map${m.map} trainer ${t.id}`); for (const s of t.party) assert(s.level <= m.cap, `map${m.map} trainer ${t.id} ${s.species} over cap`); }
  for (const side of ['kanto', 'johto']) { const g = gyms[m.map][side]; assert(g.team.length >= 2, `map${m.map} ${side} gym too small`); for (const s of g.team) checkSet(s, `map${m.map} ${g.leader}`); }
  for (const e of encounters[m.map]) { assert(e.min >= m.band[0] && e.max <= m.band[1], `map${m.map} encounter ${e.species} level out of band`); }
}
// evolution sanity: all targets exist + not removed
for (const [from, list] of Object.entries(evolution)) for (const e of list) {
  assert(!!pokedex[e.to], `evolution ${from}->${e.to} unknown target`);
  assert(!REMOVED.has(e.to), `evolution ${from}->${e.to} should be removed`);
}
assert(!evolution['eevee'] || evolution['eevee'].every((e) => e.method === 'stone'), 'eevee must be stone-only');

// ---------------------------------------------------------------------------
// WRITE
// ---------------------------------------------------------------------------
const write = (name, obj) => writeFileSync(join(OUT, name), JSON.stringify(obj, null, 1));
write('progression.json', progression);
write('maps.json', mapsOut);
write('encounters.json', encounters);
write('trainers.json', trainers);
write('gyms.json', gyms);
write('mart.json', mart);
write('evolution.json', evolution);

const counts = {
  catchable: CATCHABLE.length,
  trainers: Object.values(trainers).reduce((n, l) => n + l.length, 0),
  gymLeaders: MAPS.length * 2,
  evoLines: Object.keys(evolution).length,
};
console.log('World build:', JSON.stringify(counts));
if (errors.length) { console.error('VALIDATION FAILED:\n - ' + errors.join('\n - ')); process.exit(1); }
console.log('Validation: PASS — all', CATCHABLE.length, 'catchable species placed; trainers/gyms have legal movesets.');
