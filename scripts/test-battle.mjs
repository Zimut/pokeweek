// Headless battle test: runs full AI-vs-AI battles to validate the engine.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Dex } from '../src/engine/dex.js';
import { Battle } from '../src/engine/battle.js';
import { AI } from '../src/engine/ai.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, '..', 'src', 'data');

async function loadDex() {
  const [pokedex, moves, typechart, learnsets] = await Promise.all([
    readFile(join(DATA, 'pokedex.json'), 'utf8').then(JSON.parse),
    readFile(join(DATA, 'moves.json'), 'utf8').then(JSON.parse),
    readFile(join(DATA, 'typechart.json'), 'utf8').then(JSON.parse),
    readFile(join(DATA, 'learnsets.json'), 'utf8').then(JSON.parse),
  ]);
  return new Dex({ pokedex, moves, typechart, learnsets });
}

function teamOf(dex, specs) {
  return specs.map(([species, level, moves]) => ({ species, level, moves: moves || dex.defaultMoves(species, level) }));
}

function runBattle(dex, teamA, teamB, { seed = 1, verbose = false } = {}) {
  const battle = new Battle({ dex, seed, sides: [{ team: teamA, name: 'Red' }, { team: teamB, name: 'Blue' }], kind: 'trainer' });
  const ais = [new AI(battle, 0), new AI(battle, 1)];
  battle.start();
  if (verbose) printLog(battle.flushLog());
  let guard = 0;
  while (battle.state !== 'end' && guard++ < 2000) {
    for (let i = 0; i < 2; i++) {
      const need = battle.needAction(i);
      if (need) battle.choose(i, ais[i].decide());
    }
    battle.go();
    if (verbose) printLog(battle.flushLog());
    else battle.flushLog();
  }
  return { winner: battle.winner, turns: battle.turn, timedOut: guard >= 2000 };
}

function printLog(events) {
  for (const e of events) {
    if (e.type === 'turn') console.log(`\n--- Turn ${e.n} ---`);
    else if (e.text) console.log(e.text);
  }
}

async function main() {
  const dex = await loadDex();
  const verbose = process.argv.includes('-v');

  const teamA = teamOf(dex, [
    ['typhlosion', 50, ['flamethrower', 'thunderpunch', 'earthquake', 'swift']],
    ['feraligatr', 50, ['surf', 'icebeam', 'earthquake', 'crunch']],
    ['snorlax', 50, ['bodyslam', 'earthquake', 'rest', 'curse']],
  ]);
  const teamB = teamOf(dex, [
    ['meganium', 50, ['razorleaf', 'bodyslam', 'synthesis', 'leechseed']],
    ['ampharos', 50, ['thunderbolt', 'firepunch', 'thunderwave', 'lightscreen']],
    ['gengar', 50, ['shadowball', 'thunderbolt', 'hypnosis', 'dreameater']],
  ]);

  if (verbose) {
    runBattle(dex, teamA, teamB, { seed: 7, verbose: true });
    return;
  }

  // Stress test: many seeds, ensure no crashes / no timeouts.
  let aWins = 0, bWins = 0, ties = 0, timeouts = 0, totalTurns = 0;
  const N = 200;
  for (let s = 0; s < N; s++) {
    const r = runBattle(dex, teamA, teamB, { seed: s + 1 });
    if (r.timedOut) timeouts++;
    if (r.winner === 0) aWins++; else if (r.winner === 1) bWins++; else ties++;
    totalTurns += r.turns;
  }
  console.log(`Ran ${N} battles. Red ${aWins} / Blue ${bWins} / ties ${ties} / timeouts ${timeouts}. Avg turns ${(totalTurns / N).toFixed(1)}.`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
