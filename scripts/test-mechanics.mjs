// Scripted scenarios that drive specific moves to verify tricky mechanics.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Dex } from '../src/engine/dex.js';
import { Battle } from '../src/engine/battle.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, '..', 'src', 'data');

async function loadDex() {
  const [pokedex, moves, typechart, learnsets] = await Promise.all(
    ['pokedex', 'moves', 'typechart', 'learnsets'].map((f) => readFile(join(DATA, `${f}.json`), 'utf8').then(JSON.parse)),
  );
  return new Dex({ pokedex, moves, typechart, learnsets });
}

function mk(species, level, moves) { return { species, level, moves }; }

// Find a move slot index by id for the active pokemon of a side.
function mi(battle, side, id) {
  const p = battle.sides[side].active;
  const i = p.moveSlots.findIndex((m) => m.id === id);
  if (i < 0) throw new Error(`${p.name} has no move ${id}`);
  return i;
}

function printLog(events) {
  for (const e of events) {
    if (e.type === 'turn') console.log(`-- turn ${e.n} --`);
    else if (e.type === 'damage' && e.dmg) console.log(`   (${e.name} took ${e.dmg} dmg -> ${e.hp}/${e.maxhp})`);
    else if (e.text) console.log('   ' + e.text);
  }
}

// Play one turn given move ids (or 'forced' to let the engine auto-fill).
function turn(battle, id0, id1) {
  if (battle.needAction(0)) battle.choose(0, id0 === 'forced' ? {} : { type: 'move', move: mi(battle, 0, id0) });
  if (battle.needAction(1)) battle.choose(1, id1 === 'forced' ? {} : { type: 'move', move: mi(battle, 1, id1) });
  battle.go();
  printLog(battle.flushLog());
}

function scenario(title, fn) { console.log(`\n=== ${title} ===`); fn(); }

async function main() {
  const dex = await loadDex();
  const newBattle = (t0, t1, seed = 3) => {
    const b = new Battle({ dex, seed, sides: [{ team: t0, name: 'P1' }, { team: t1, name: 'P2' }], kind: 'trainer' });
    b.start(); printLog(b.flushLog()); return b;
  };

  scenario('Two-turn Fly + semi-invulnerability', () => {
    const b = newBattle([mk('pidgeot', 50, ['fly', 'quickattack'])], [mk('snorlax', 50, ['bodyslam', 'rest'])]);
    turn(b, 'fly', 'bodyslam');   // Pidgeot charges & is airborne; Body Slam should miss
    turn(b, 'forced', 'bodyslam'); // Fly strikes
  });

  scenario('Hyper Beam recharge', () => {
    const b = newBattle([mk('snorlax', 60, ['hyperbeam', 'bodyslam'])], [mk('steelix', 60, ['irontail', 'rest'])]);
    turn(b, 'hyperbeam', 'rest');
    turn(b, 'hyperbeam', 'rest'); // should be forced to recharge instead
  });

  scenario('Toxic ramping damage', () => {
    const b = newBattle([mk('gengar', 50, ['toxic', 'nightshade'])], [mk('snorlax', 50, ['rest', 'bodyslam'])]);
    turn(b, 'toxic', 'bodyslam');
    turn(b, 'nightshade', 'bodyslam');
    turn(b, 'nightshade', 'bodyslam');
  });

  scenario('Fixed-damage moves (Night Shade / Seismic Toss)', () => {
    // Gengar (Ghost) hits Machamp (Fighting) for exactly its level (50).
    const b = newBattle([mk('gengar', 50, ['nightshade', 'seismictoss'])], [mk('machamp', 50, ['bodyslam', 'rest'])]);
    turn(b, 'nightshade', 'rest');   // 50 fixed damage to Machamp
    turn(b, 'seismictoss', 'rest');  // 50 fixed damage to Machamp
  });

  scenario('Variable-power moves (Return / Magnitude / Super Fang)', () => {
    // Feraligatr's Return (Normal, BP 102) and Magnitude (Ground) land on Machamp;
    // Super Fang halves Machamp's current HP.
    const b = newBattle([mk('feraligatr', 50, ['return', 'magnitude', 'superfang'])], [mk('machamp', 50, ['rest', 'bodyslam'])]);
    turn(b, 'return', 'rest');     // ~BP 102 physical hit
    turn(b, 'magnitude', 'rest');  // random magnitude power
    turn(b, 'superfang', 'rest');  // halves Machamp's HP
  });

  scenario('Substitute blocks status', () => {
    const b = newBattle([mk('alakazam', 50, ['substitute', 'psychic'])], [mk('gengar', 50, ['thunderwave', 'shadowball'])]);
    turn(b, 'substitute', 'thunderwave'); // sub absorbs; status should not apply
  });

  scenario('Leech Seed drain', () => {
    const b = newBattle([mk('venusaur', 50, ['leechseed', 'razorleaf'])], [mk('snorlax', 50, ['bodyslam', 'rest'])]);
    turn(b, 'leechseed', 'bodyslam');
    turn(b, 'razorleaf', 'bodyslam');
  });

  scenario('Rest fully heals & sleeps', () => {
    const b = newBattle([mk('snorlax', 50, ['rest', 'bodyslam'])], [mk('machamp', 50, ['crosschop', 'earthquake'])], 9);
    turn(b, 'bodyslam', 'earthquake');
    turn(b, 'rest', 'earthquake');
  });

  scenario('Counter reflects physical damage', () => {
    const b = newBattle([mk('snorlax', 50, ['counter', 'bodyslam'])], [mk('machamp', 50, ['crosschop', 'earthquake'])]);
    turn(b, 'counter', 'earthquake');
  });

  scenario('Self-Destruct faints user', () => {
    const b = newBattle([mk('electrode', 50, ['explosion', 'thunderbolt'])], [mk('snorlax', 50, ['bodyslam', 'rest'])]);
    turn(b, 'explosion', 'bodyslam');
  });
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
