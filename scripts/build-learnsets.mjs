// Builds Gen 2 learnsets (level-up + TM/HM machine only; no breeding/tutor)
// from PokeAPI, which exposes version-group-specific learn data.
// Keyed by Showdown-style species id so it lines up with pokedex.json.
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'src', 'data');
const API = 'https://pokeapi.co/api/v2/pokemon';
const VERSION_GROUPS = new Set(['gold-silver', 'crystal']);
const CONCURRENCY = 12;

// Normalize a PokeAPI kebab name to a Showdown id (lowercase, alphanumeric).
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
// PokeAPI vs Showdown move id discrepancies.
const MOVE_ALIASES = { vicegrip: 'visegrip' };
const normMove = (s) => { const n = norm(s); return MOVE_ALIASES[n] || n; };

async function fetchJson(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res.json();
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  throw new Error('Failed to fetch ' + url);
}

async function buildOne(id) {
  const p = await fetchJson(`${API}/${id}`);
  const speciesId = norm(p.name);
  const lv = {};      // moveId -> { gs, cr }
  const machine = new Set();

  for (const m of p.moves) {
    const mid = normMove(m.move.name);
    for (const vgd of m.version_group_details) {
      const vg = vgd.version_group.name;
      if (!VERSION_GROUPS.has(vg)) continue;
      const method = vgd.move_learn_method.name;
      if (method === 'level-up') {
        lv[mid] = lv[mid] || {};
        lv[mid][vg === 'crystal' ? 'cr' : 'gs'] = vgd.level_learned_at;
      } else if (method === 'machine') {
        machine.add(mid);
      }
    }
  }

  const levelup = Object.entries(lv)
    .map(([move, o]) => ({ move, level: (o.cr ?? o.gs) || 1 }))
    .sort((a, b) => a.level - b.level || a.move.localeCompare(b.move));

  return { speciesId, num: p.id, data: { num: p.id, levelup, machine: [...machine].sort() } };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const result = {};
  const ids = Array.from({ length: 251 }, (_, i) => i + 1);
  let done = 0;

  // Simple concurrency pool.
  const queue = [...ids];
  async function worker() {
    while (queue.length) {
      const id = queue.shift();
      const { speciesId, data } = await buildOne(id);
      result[speciesId] = data;
      done++;
      if (done % 25 === 0 || done === ids.length) process.stdout.write(`  fetched ${done}/251\n`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Order output by national dex number for readability.
  const ordered = {};
  for (const key of Object.keys(result).sort((a, b) => result[a].num - result[b].num)) {
    ordered[key] = result[key];
  }
  await writeFile(join(OUT, 'learnsets.json'), JSON.stringify(ordered));

  // Cross-check against pokedex + moves for integrity.
  const dex = JSON.parse(await readFile(join(OUT, 'pokedex.json'), 'utf8'));
  const moves = JSON.parse(await readFile(join(OUT, 'moves.json'), 'utf8'));
  const missingSpecies = Object.keys(ordered).filter((k) => !dex[k]);
  const unknownMoves = new Set();
  for (const ls of Object.values(ordered)) {
    for (const e of ls.levelup) if (!moves[e.move]) unknownMoves.add(e.move);
    for (const mv of ls.machine) if (!moves[mv]) unknownMoves.add(mv);
  }
  const dexMissingLearnset = Object.keys(dex).filter((k) => !ordered[k]);

  console.log(`Wrote learnsets.json (${Object.keys(ordered).length} species)`);
  console.log('Species in learnsets missing from pokedex:', missingSpecies.length ? missingSpecies.join(', ') : 'none');
  console.log('Pokedex species missing a learnset:', dexMissingLearnset.length ? dexMissingLearnset.join(', ') : 'none');
  console.log('Learnset move ids not in moves.json:', unknownMoves.size ? [...unknownMoves].join(', ') : 'none');
}

main().catch((e) => { console.error(e); process.exit(1); });
