import { calcDamage, moveType, effectivenessOf } from './damage.js';

// A pragmatic battle AI: picks the move with the best expected damage (with a
// nudge toward status/setup when it can't threaten a KO), and switches to a
// favourable matchup when forced.
export class AI {
  constructor(battle, sideIndex) {
    this.battle = battle;
    this.side = sideIndex;
  }

  decide() {
    const b = this.battle;
    const action = b.needAction(this.side);
    if (action === 'switch') return { type: 'switch', target: this.bestSwitch() };
    if (action !== 'choice') return null;
    const req = b.getRequest(this.side);
    if (req.forceMove) return { type: 'move', forced: req.forceMove };

    const me = b.sides[this.side].active;
    const foeSide = b.sides[this.side === 0 ? 1 : 0];
    const foe = foeSide.active;
    const usable = req.active.moves.filter((m) => !m.disabled);
    if (!usable.length) return { type: 'move', move: 0 };

    // Attacks are scored as a percentage of the foe's current HP (so weak
    // low-level hits still compete with status moves on a level scale), with a
    // big bonus for a guaranteed KO. Status moves are deliberately capped well
    // below a solid attack and lose value once applied, so the AI attacks by
    // default and only sets up / inflicts status occasionally instead of spamming.
    let best = null, bestScore = -Infinity;
    for (const m of usable) {
      const move = me.getMoveSlot(m.id).move;
      let score;
      if (move.id === 'dreameater' && foe.status !== 'slp') {
        score = 0; // Dream Eater only works on a sleeping target.
      } else if (move.category === 'Status') {
        score = this.statusScore(move, me, foe);
      } else {
        const res = calcDamage(b, me, foe, move, foeSide, { crit: false });
        if (res.damage <= 0) score = 0;                       // immune / no power
        else if (res.damage >= foe.hp) score = 160;           // guaranteed KO
        else {
          // Baseline so any real attack outranks a marginal status move, plus
          // the fraction of the foe's HP it removes (bigger hits preferred).
          score = 12 + Math.min(83, (100 * res.damage) / Math.max(1, foe.hp));
          if (res.effectiveness === 'super') score += 12;
          else if (res.effectiveness === 'resist') score -= 8;
        }
      }
      score += b.rng.int(0, 4); // small noise to vary play
      if (score > bestScore) { bestScore = score; best = m; }
    }
    return { type: 'move', move: best.index };
  }

  // Situational value for a status move, on the same 0–~100 scale as attacks.
  // Each kind is worth less than a real attack and drops to ~0 once applied, so
  // the AI never loops the same buff/debuff every turn.
  statusScore(move, me, foe) {
    // Recovery — only when genuinely hurt.
    if (move.id === 'rest') return me.hp < me.maxhp * 0.45 ? 55 : 0;
    if (move.heal) return me.hp < me.maxhp * 0.40 ? 55 : 0;

    // Self setup — scaled by how much it boosts, so a strong setup (Swords
    // Dance, +2) is worth one turn but a marginal +1 (Defense Curl) loses to
    // almost any attack. Already being boosted kills it (no looping buffs).
    if (move.boosts && move.target === 'self') {
      const gain = Object.values(move.boosts).reduce((a, c) => a + Math.max(0, c), 0);
      const have = Object.values(me.boosts).reduce((a, c) => a + Math.max(0, c), 0);
      return gain <= 0 ? 6 : Math.max(0, gain * 11 - have * 24);
    }

    // Inflict a status condition — only if the foe has none.
    if (move.status) return foe.status ? 0 : 26;

    // Lower the foe's stats — minor, and pointless once already lowered.
    if (move.boosts) {
      const debuffed = Object.values(foe.boosts).reduce((a, c) => a + Math.min(0, c), 0);
      return Math.max(0, 12 + debuffed * 10);
    }

    return 8; // other utility (screens, etc.)
  }

  bestSwitch() {
    const b = this.battle;
    const side = b.sides[this.side];
    const foe = b.sides[this.side === 0 ? 1 : 0].active;
    const options = side.switchableIndices();
    if (!options.length) return side.activeIndex;
    let best = options[0], bestScore = -Infinity;
    for (const i of options) {
      const p = side.team[i];
      let score = 0;
      // Outgoing: best STAB effectiveness.
      for (const t of p.types) score += (effectivenessOf(b.dex, t, foe) - 1) * 2;
      // Incoming: penalize being weak to foe STAB.
      for (const t of foe.types) score -= (effectivenessOf(b.dex, t, p) - 1) * 2;
      score += p.hpPercent();
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }
}
