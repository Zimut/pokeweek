// Builds human-readable move descriptions and type-effectiveness cues for the
// battle UI's FIGHT menu. Descriptions are derived from OUR generated Gen 2
// move data (and the engine's actual behaviour) rather than Showdown's modern
// shortDesc text, which misdescribes several Gen 2 mechanics (e.g. Crunch lowers
// Sp. Def in Gen 2, not Defense). This keeps the tooltip consistent with what
// the move really does in PokeWeek.

const STAT_NAMES = {
  atk: 'Attack', def: 'Defense', spa: 'Sp. Atk', spd: 'Sp. Def',
  spe: 'Speed', accuracy: 'accuracy', evasion: 'evasiveness',
};

const STATUS_VERB = {
  par: 'paralyze the target',
  brn: 'burn the target',
  psn: 'poison the target',
  tox: 'badly poison the target',
  slp: 'put the target to sleep',
  frz: 'freeze the target',
};

const STATUS_SENTENCE = {
  par: 'Paralyzes the target, which may leave it unable to move.',
  brn: 'Burns the target, sapping HP each turn and halving its Attack.',
  psn: 'Poisons the target, sapping HP each turn.',
  tox: 'Badly poisons the target; the damage grows worse every turn.',
  slp: 'Puts the target to sleep.',
  frz: 'Freezes the target solid.',
};

// inf=true gives the bare infinitive ("sharply raise") for "chance to ___"
// constructions; inf=false gives the finite form ("sharply raises") for a
// standalone sentence.
function raiseWord(n, inf) {
  const w = n >= 3 ? 'drastically raise' : n === 2 ? 'sharply raise' : 'raise';
  return inf ? w : w + 's';
}
function lowerWord(n, inf) {
  const w = n <= -3 ? 'severely lower' : n === -2 ? 'harshly lower' : 'lower';
  return inf ? w : w + 's';
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// "raises the user's Attack", "harshly lower the target's Defense", etc.
function boostPhrase(boosts, owner, inf = false) {
  const entries = Object.entries(boosts);
  // All five battle stats moving the same way -> "all of its stats".
  const battle = ['atk', 'def', 'spa', 'spd', 'spe'];
  if (entries.length >= 5 && battle.every((s) => boosts[s] === entries[0][1])) {
    const n = entries[0][1];
    return `${n > 0 ? raiseWord(n, inf) : lowerWord(n, inf)} all of ${owner} stats`;
  }
  const parts = entries.map(([stat, n]) => {
    const verb = n > 0 ? raiseWord(n, inf) : lowerWord(n, inf);
    return `${verb} ${owner} ${STAT_NAMES[stat] || stat}`;
  });
  return parts.join(' and ');
}

function multihitSentence(mh) {
  if (Array.isArray(mh)) return `Hits ${mh[0]}–${mh[1]} times in one turn.`;
  return `Hits ${mh} times in one turn.`;
}

const WEATHER_SENTENCE = {
  RainDance: 'Summons rain for five turns, powering up Water moves and weakening Fire moves.',
  sunnyday: 'Summons harsh sunlight for five turns, powering up Fire moves and weakening Water moves.',
  Sandstorm: 'Whips up a sandstorm that chips away at all but Rock, Ground and Steel types.',
};

const SIDE_SENTENCE = {
  reflect: 'Halves damage from physical attacks for five turns.',
  lightscreen: 'Halves damage from special attacks for five turns.',
  safeguard: "Shields the user's team from status conditions for several turns.",
  spikes: 'Scatters spikes that hurt grounded foes as they switch in.',
};

const VOLATILE_PRIMARY = {
  partiallytrapped: 'Traps the target for several turns, hurting it each turn and preventing escape.',
  attract: 'Infatuates a target of the opposite gender, which may keep it from attacking.',
};

// Concise effect for the chance% secondary effect of an attacking move.
function secondarySentence(sec) {
  const chance = sec.chance != null ? `${sec.chance}% chance to ` : 'May ';
  if (sec.status) return `${chance}${STATUS_VERB[sec.status] || ('inflict ' + sec.status)}.`;
  if (sec.volatileStatus === 'flinch') return `${chance}make the target flinch.`;
  if (sec.volatileStatus === 'confusion') return `${chance}confuse the target.`;
  if (sec.self && sec.self.boosts) return `${chance}${boostPhrase(sec.self.boosts, "the user's", true)}.`;
  if (sec.boosts) return `${chance}${boostPhrase(sec.boosts, "the target's", true)}.`;
  return '';
}

// Moves whose behaviour isn't captured by plain data fields (custom engine
// handlers, charge moves, fixed/variable-power moves). Keyed by move id.
const CURATED = {
  // recovery / defensive
  rest: 'The user sleeps for two turns, fully restoring HP and curing any status.',
  recover: "Restores up to half of the user's max HP.",
  softboiled: "Restores up to half of the user's max HP.",
  milkdrink: "Restores up to half of the user's max HP.",
  moonlight: "Restores HP — more in sunshine, less in bad weather.",
  morningsun: "Restores HP — more in sunshine, less in bad weather.",
  synthesis: "Restores HP — more in sunshine, less in bad weather.",
  substitute: 'Sacrifices 1/4 of max HP to create a decoy that absorbs hits.',
  protect: 'Shields the user from all moves this turn. Likely to fail if used in a row.',
  detect: 'Shields the user from all moves this turn. Likely to fail if used in a row.',
  endure: 'The user survives any hit this turn with at least 1 HP. Less reliable used repeatedly.',
  bellydrum: 'Halves the max HP to maximize the Attack stat.',
  painsplit: "Adds both Pokémon's HP together and splits it evenly between them.",
  // field / screens
  reflect: 'Halves damage from physical attacks for five turns.',
  lightscreen: 'Halves damage from special attacks for five turns.',
  safeguard: "Shields the user's team from status conditions for several turns.",
  mist: "Prevents the user's stats from being lowered for several turns.",
  haze: 'Eliminates all stat changes on both Pokémon.',
  spikes: 'Scatters spikes that hurt grounded foes as they switch in.',
  raindance: 'Summons rain for five turns, powering up Water moves and weakening Fire moves.',
  sunnyday: 'Summons harsh sunlight for five turns, powering up Fire moves and weakening Water moves.',
  sandstorm: 'Whips up a sandstorm that chips away at all but Rock, Ground and Steel types.',
  // status / trapping / control
  leechseed: "Plants a seed that saps the target's HP each turn to heal the user. Grass types resist it.",
  focusenergy: "Raises the user's critical-hit ratio.",
  confuseray: 'Confuses the target.',
  supersonic: 'Confuses the target.',
  sweetkiss: 'Confuses the target.',
  swagger: "Sharply raises the target's Attack, but confuses it.",
  flatter: "Raises the target's Sp. Atk, but confuses it.",
  attract: 'Infatuates a target of the opposite gender, which may keep it from attacking.',
  disable: "Disables the target's last-used move for a few turns.",
  encore: 'Forces the target to repeat its last move for several turns.',
  meanlook: 'Prevents the target from fleeing or switching out.',
  spiderweb: 'Prevents the target from fleeing or switching out.',
  foresight: 'Lets Normal- and Fighting-type moves hit Ghosts, and negates evasion boosts.',
  nightmare: 'A sleeping target loses 1/4 of its HP each turn.',
  destinybond: 'If the user faints this turn, the attacker is dragged down with it.',
  perishsong: 'Every Pokémon that hears it faints in three turns unless switched out.',
  curse: "Ghost types sacrifice half their HP to curse the target (losing HP each turn); other types lower Speed to raise Attack and Defense.",
  psychup: "Copies all of the target's stat changes.",
  conversion: "Changes the user's type to match one of its moves.",
  // counterattacks
  counter: 'Strikes back at double the power of the last physical hit the user took.',
  mirrorcoat: 'Strikes back at double the power of the last special hit the user took.',
  bide: 'The user endures for two turns, then deals back double the damage it took.',
  // copy / random
  metronome: 'Randomly unleashes almost any move in the game.',
  mirrormove: 'Counters with the move the target last used.',
  mimic: "Copies the target's last move until the user switches out.",
  sketch: "Permanently copies the target's last move.",
  sleeptalk: "Randomly uses one of the user's own moves while asleep.",
  transform: 'The user transforms into the target, copying its appearance, stats and moves.',
  conversion2: "Changes the user's type to resist the target's last move.",
  // forced switch
  whirlwind: 'Forces the target to switch out. Fails if it has nowhere to go.',
  roar: 'Forces the target to switch out. Fails if it has nowhere to go.',
  // charge / two-turn
  solarbeam: 'Gathers light on the first turn, then fires a powerful beam on the second.',
  skyattack: 'Glows on the first turn, then strikes hard on the second.',
  razorwind: 'Whips up a whirlwind on the first turn, then attacks on the second.',
  skullbash: 'Tucks in its head (raising Defense) on the first turn, then attacks.',
  fly: 'Flies up out of reach on the first turn, then strikes on the second.',
  dig: 'Burrows underground on the first turn, then strikes on the second.',
  // multi-turn lock
  thrash: 'Rampages for two or three turns, then leaves the user confused.',
  petaldance: 'Rampages for two or three turns, then leaves the user confused.',
  outrage: 'Rampages for two or three turns, then leaves the user confused.',
  rollout: 'Power doubles every turn for up to five turns, and rises further after Defense Curl.',
  iceball: 'Power doubles every turn for up to five turns.',
  furycutter: 'Power doubles with each consecutive hit.',
  rage: "The user's Attack rises whenever it is hit while raging.",
  rapidspin: 'Frees the user from Leech Seed, binding moves and Spikes.',
  beatup: 'Each healthy team member piles on for an extra hit.',
  futuresight: 'Foretells an attack that strikes two turns later.',
  doomdesire: 'Foretells an attack that strikes two turns later.',
  triattack: 'May paralyze, burn, or freeze the target.',
  // fixed damage
  seismictoss: "Deals damage equal to the user's level. No effect on Ghost types.",
  nightshade: "Deals damage equal to the user's level. No effect on Normal types.",
  dragonrage: 'Always deals exactly 40 HP of damage.',
  sonicboom: 'Always deals exactly 20 HP of damage.',
  psywave: "Deals a random amount of damage based on the user's level.",
  superfang: "Halves the target's current HP.",
  fissure: 'A one-hit KO — but only against Pokémon of equal or lower level.',
  horndrill: 'A one-hit KO — but only against Pokémon of equal or lower level.',
  guillotine: 'A one-hit KO — but only against Pokémon of equal or lower level.',
  // variable power
  flail: "The lower the user's HP, the stronger the attack.",
  reversal: "The lower the user's HP, the stronger the attack.",
  magnitude: 'Power varies at random, from a weak rumble to a massive quake.',
  return: 'The friendlier the user, the more powerful the attack.',
  frustration: 'The less friendly the user, the more powerful the attack.',
  present: 'A gift of varying power — but it sometimes restores the target’s HP instead.',
  hiddenpower: "Its type and power are determined by the user's genes.",
  // misc
  splash: 'Does absolutely nothing.',
  spite: "Cuts the PP of the target's last-used move.",
};

// Build a one-line effect description for a (full, dex) move object.
export function moveDescription(move) {
  if (CURATED[move.id]) return CURATED[move.id];

  const out = [];
  if (move.status && STATUS_SENTENCE[move.status]) out.push(STATUS_SENTENCE[move.status]);
  if (move.volatileStatus && VOLATILE_PRIMARY[move.volatileStatus]) out.push(VOLATILE_PRIMARY[move.volatileStatus]);
  if (move.boosts) {
    const owner = move.target === 'self' ? "the user's" : "the target's";
    out.push(cap(boostPhrase(move.boosts, owner)) + '.');
  }
  if (move.heal) out.push("Restores some of the user's HP.");
  if (move.drain) out.push("Drains HP from the target to heal the user.");
  if (move.recoil) out.push('The user is hit with recoil damage.');
  if (move.multihit) out.push(multihitSentence(move.multihit));
  if (move.ohko) out.push('A one-hit KO if it connects.');
  if (move.forceSwitch) out.push('Forces the target to switch out.');
  if (move.selfdestruct) out.push('The user faints after attacking.');
  if (move.weather && WEATHER_SENTENCE[move.weather]) out.push(WEATHER_SENTENCE[move.weather]);
  if (move.sideCondition && SIDE_SENTENCE[move.sideCondition]) out.push(SIDE_SENTENCE[move.sideCondition]);
  if (move.secondary) { const s = secondarySentence(move.secondary); if (s) out.push(s); }
  if (move.critRatio && move.critRatio >= 2) out.push('Has a high critical-hit ratio.');
  if (move.priority > 0) out.push('Almost always strikes first.');
  if (move.priority < 0) out.push('Almost always strikes last.');

  if (!out.length) {
    return move.category === 'Status'
      ? 'No notable effect.'
      : 'A straightforward attack with no added effect.';
  }
  return out.join(' ');
}

// ---- type effectiveness cue --------------------------------------------------
// Moves whose damage scales with type effectiveness use the full multiplier.
// Fixed/OHKO moves only react to immunity (their damage doesn't scale), and we
// only flag the ones the engine actually treats as immune-checked.
const VARIABLE_DMG = new Set(['magnitude', 'flail', 'reversal', 'return', 'frustration', 'present', 'hiddenpower']);
const IMMUNE_ONLY = new Set(['seismictoss', 'nightshade', 'psywave', 'superfang', 'fissure', 'horndrill', 'guillotine']);

const LABELS = {
  4: { cls: 'eff-super', badge: '4×', tip: 'Super effective (4×)' },
  2: { cls: 'eff-super', badge: '2×', tip: 'Super effective (2×)' },
  0.5: { cls: 'eff-resist', badge: '½×', tip: 'Not very effective (½×)' },
  0.25: { cls: 'eff-resist', badge: '¼×', tip: 'Not very effective (¼×)' },
  0: { cls: 'eff-immune', badge: '0×', tip: 'No effect' },
};

// Returns { mult, cls, badge, tip } or null when there's nothing to flag.
// `type` is the resolved move type (Hidden Power varies by the user's DVs).
export function effectivenessInfo(move, type, dex, defenderTypes) {
  if (!defenderTypes || !defenderTypes.length) return null;
  const scaling = move.category !== 'Status' || VARIABLE_DMG.has(move.id);
  const immuneOnly = IMMUNE_ONLY.has(move.id);
  if (!scaling && !immuneOnly) return null;

  const mult = dex.effectiveness(type, defenderTypes);
  if (!scaling) return mult === 0 ? { mult, ...LABELS[0] } : null; // fixed/OHKO: only immunity matters
  if (mult === 1) return null;
  const info = LABELS[mult];
  return info ? { mult, ...info } : null;
}
