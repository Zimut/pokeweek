import { hiddenPower } from './stats.js';
import { PHYSICAL_TYPES } from './constants.js';

// Resolve the type a move uses this turn (Hidden Power is IV-derived).
export function moveType(move, attacker) {
  if (move.id === 'hiddenpower') return hiddenPower(attacker.ivs).type;
  return move.type;
}

export function moveCategoryFromType(type) {
  return PHYSICAL_TYPES.has(type) ? 'Physical' : 'Special';
}

// Combined type effectiveness, honouring Foresight (Normal/Fighting can hit
// Ghost) when the defender is identified.
export function effectivenessOf(dex, type, defender) {
  let mult = 1;
  const foresighted = !!defender.volatiles.foresight;
  for (const dt of defender.types) {
    let m = dex.typeMult(type, dt);
    if (m === 0 && foresighted && (type === 'Normal' || type === 'Fighting')) m = 1;
    mult *= m;
  }
  return mult;
}

export function effLabel(mult) {
  if (mult === 0) return 'immune';
  if (mult > 1) return 'super';
  if (mult < 1) return 'resist';
  return 'normal';
}

// Full Gen 2 damage calculation for a standard damaging move.
// opts: { crit, powerOverride, typeOverride }
export function calcDamage(battle, attacker, defender, move, defenderSide, opts = {}) {
  const dex = battle.dex;
  const type = opts.typeOverride || moveType(move, attacker);
  const category = move.category === 'Status' ? moveCategoryFromType(type) : move.category;
  let power = opts.powerOverride != null ? opts.powerOverride
    : (move.id === 'hiddenpower' ? hiddenPower(attacker.ivs).power : move.basePower);
  if (!power) return { damage: 0, effectiveness: 'normal', typeMult: 1, crit: !!opts.crit, type };

  const mult = effectivenessOf(dex, type, defender);
  if (mult === 0) return { damage: 0, effectiveness: 'immune', typeMult: 0, crit: false, type };

  const crit = !!opts.crit;
  const physical = category === 'Physical';
  const atkStat = physical ? 'atk' : 'spa';
  const defStat = physical ? 'def' : 'spd';

  // Crits ignore stage boosts (Gen 2); burn still halves Attack.
  let A = attacker.getStat(atkStat, { boosted: !crit, statusMod: true });
  let D = defender.getStat(defStat, { boosted: !crit, statusMod: true });

  // Screens (ignored on a crit) effectively double the relevant defence.
  if (!crit) {
    if (physical && defenderSide.conditions.reflect) D *= 2;
    if (!physical && defenderSide.conditions.lightscreen) D *= 2;
  }

  // Gen 2 high-stat reduction: if either stat exceeds 255, divide both by 4.
  if (A > 255 || D > 255) { A = Math.floor(A / 4); D = Math.floor(D / 4); }
  A = Math.max(1, A); D = Math.max(1, D);

  const level = attacker.level;
  let dmg = (Math.floor((2 * level) / 5) + 2) * power;
  dmg = Math.floor((dmg * A) / D);
  dmg = Math.floor(dmg / 50);

  // Weather modifiers.
  const w = battle.field.weather;
  if (w === 'rain') { if (type === 'Water') dmg = Math.floor(dmg * 1.5); if (type === 'Fire') dmg = Math.floor(dmg / 2); }
  if (w === 'sun') { if (type === 'Fire') dmg = Math.floor(dmg * 1.5); if (type === 'Water') dmg = Math.floor(dmg / 2); }

  dmg += 2;

  if (crit) dmg *= 2;

  // STAB.
  if (attacker.hasType(type)) dmg = Math.floor(dmg * 1.5);

  // Type effectiveness (apply each defending type's factor).
  for (const dt of defender.types) {
    let m = dex.typeMult(type, dt);
    if (m === 0 && defender.volatiles.foresight && (type === 'Normal' || type === 'Fighting')) m = 1;
    if (m !== 1) dmg = Math.floor(dmg * m);
  }

  // Random factor 217..255 / 255.
  const r = battle.rng.int(217, 255);
  dmg = Math.floor((dmg * r) / 255);
  if (dmg < 1) dmg = 1;

  return { damage: dmg, effectiveness: effLabel(mult), typeMult: mult, crit, type, category };
}
