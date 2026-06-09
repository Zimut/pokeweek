// Single-player game session: holds the player's persistent state (party, box,
// money, bag, balls, badges, beaten trainers) and wires the overworld's
// interaction hooks to actual gameplay — currently wild encounters + catching.
// The lobby/persistence layer (Task 16) will create and sync this state across
// the network; for now app.js builds one locally.
import { toId } from '../engine/dex.js';
import { computeStats, MAX_IVS, DEFAULT_IVS, ZERO_EVS, MAX_EV, EV_TOTAL_MAX } from '../engine/stats.js';
import { Overworld } from './overworld.js';
import { WildBattleView } from './wildbattle.js';
import { TrainerBattleView } from './trainerbattle.js';
import { MartView } from './mart.js';
import { PartyMenu } from './menu.js';
import { NetworkBattleView } from './net.js';
import { SpectateView } from './spectate.js';
import { spriteFront, TYPE_COLORS, expToNext } from './data.js';
import { sfx } from './sfx.js';

// Stat keys/labels shared by the menu summary and vitamin items.
export const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
export const STAT_LABEL = { hp: 'HP', atk: 'Attack', def: 'Defense', spa: 'Sp. Atk', spd: 'Sp. Def', spe: 'Speed' };
const STAT_SHORT = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };
// EXP granted per level of every Pokémon defeated. Participants get the full
// amount; benched Pokémon get BENCH_EXP_SHARE of it (modern "EXP Share" style).
const EXP_PER_FOE_LEVEL = 5;
const BENCH_EXP_SHARE = 0.5;
// The PC Box holds at most 6 Pokémon. When the team (6) and box (6) are both
// full, a new catch replaces the last Pokémon in the box.
const BOX_SIZE = 6;

const el = (tag, props = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of [].concat(kids)) if (c != null) n.append(c);
  return n;
};

const randint = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

// Poké Balls are tuned to catch ~2x more readily than the raw rarity rates.
const POKEBALL_EASE = 2;

// Per-throw catch probability. Lower foe HP and status raise it. Great Balls are
// a guaranteed catch; Poké Balls use the rarity-tiered base values from
// progression.json, eased by POKEBALL_EASE.
export function catchChance(progression, rarity, hpPct, status, ball) {
  if (ball === 'greatball') return 1; // Great Ball = guaranteed catch
  const base = progression.catchBaseByRarity[rarity] ?? 0.3;
  const ballMult = progression.ballMult[ball] ?? 1;
  const hpFactor = 1 - 0.65 * Math.max(0, Math.min(1, hpPct)); // full HP→0.35, fainting→~1
  const statusMult = (status === 'slp' || status === 'frz') ? 2.0
    : (status === 'par' || status === 'brn' || status === 'psn' || status === 'tox') ? 1.5 : 1.0;
  const p = base * ballMult * hpFactor * statusMult * POKEBALL_EASE;
  return Math.max(0.06, Math.min(0.95, p));
}

// The per-map catch-encounter allowance (lobby setting) as a number/Infinity.
export function encounterMaxValue(setting) {
  return setting === 'infinite' ? Infinity : (Number(setting) || 10);
}

// A random Lv5 gift species drawn from the Route 1 + Route 2 wild pools.
function giftSpeciesFor(world) {
  const enc = world.encounters || {};
  const pool = [...(enc[1] || []), ...(enc[2] || [])].map((e) => e.species).filter(Boolean);
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : world.progression.starters[0];
}

// Build a fresh local game state (used until the lobby system supplies one).
export function createGameState(dex, world, opts = {}) {
  const gift = opts.starter || giftSpeciesFor(world);
  const encounterSetting = opts.encounterAllowance ?? 10;
  const emax = encounterMaxValue(encounterSetting);
  const m1 = world.mapById[1];
  const lead = makeMon(dex, gift, opts.starterLevel || 5);
  lead.ivs = { ...DEFAULT_IVS }; // gifts are a fixed 15 in every stat
  return {
    name: opts.name || 'You',
    mode: opts.mode || 'free',
    map: 1, x: m1.spawn.x, y: m1.spawn.y, facing: 'up',
    money: world.progression.startMoney,
    badges: {}, beatenTrainers: {},
    party: [lead],
    box: [],
    bag: {},                                    // item id → count (Task 15)
    candies: {},                                // stat → EV-candy count
    encounterSetting,                           // catchable encounters per map
    // Per-map remaining catchable encounters; granted once on first visit.
    encounters: emax === Infinity ? {} : { 1: emax },
    wildSeen: 0,                                // scripted intro levels (3,4,5)
    // Poké Balls are unlimited/free now; only Great Balls (bought) are counted.
    balls: { pokeball: Infinity, greatball: 0 },
    caught: { [toId(gift)]: true },
  };
}

// Random IVs (0–31 per stat) — each caught Pokémon's genetics.
function randomIVs() {
  const r = () => Math.floor(Math.random() * 32);
  return { hp: r(), atk: r(), def: r(), spa: r(), spd: r(), spe: r() };
}

// A persistent party/box member ("set" the engine understands). Shinies are
// perfect (31) in every IV; everything else rolls random IVs and starts at 0 EV.
export function makeMon(dex, species, level, shiny = false) {
  return { species: toId(species), level, shiny, ivs: shiny ? { ...MAX_IVS } : randomIVs(), evs: { ...ZERO_EVS }, moves: dex.defaultMoves(species, level) };
}

// Build a runtime game state from a server save + lobby config. Lobby-level
// settings (mode / encounter allowance) come from config; everything else is the
// player's persisted save.
export function gameStateFromSave(world, config, save) {
  // Poké Balls are unlimited/free now; keep only the bought Great Ball count.
  const balls = { pokeball: Infinity, greatball: (save.balls && save.balls.greatball) || 0 };
  const encounterSetting = config.encounterAllowance ?? config.ballAllowance ?? 10;
  const emax = encounterMaxValue(encounterSetting);
  let encounters = (save.encounters && typeof save.encounters === 'object') ? { ...save.encounters } : null;
  if (!encounters) encounters = emax === Infinity ? {} : { [save.map || 1]: emax };
  return {
    name: save.name || 'Player',
    character: save.character || 'red',
    mode: config.mode,
    encounterSetting,
    encounters,
    unlockedMap: config.unlockedMap,
    // Lobby-level week schedule (Task 18) — runtime only, refreshed by the
    // server's `dayAdvanced` pushes; never written back into the save.
    dayIndex: config.dayIndex || 0,
    weekLength: config.weekLength || config.mapCount,
    weekLocked: !!config.locked,
    map: save.map || 1, x: save.x || 0, y: save.y || 0, facing: save.facing || 'up',
    money: save.money || 0,
    badges: save.badges || {}, beatenTrainers: save.beatenTrainers || {},
    party: save.party || [], box: save.box || [], bag: save.bag || {},
    candies: save.candies || {},
    balls,
    wildSeen: save.wildSeen || 0,
    caught: save.caught || {},
    battledToday: !!save.battledToday,
  };
}

// Reduce a runtime state to the JSON-safe save the server persists. Only the
// Great Ball count is stored (Poké Balls are unlimited); per-map remaining
// catchable encounters are stored in `encounters`.
export function serializeSave(state) {
  return {
    name: state.name, character: state.character,
    map: state.map, x: state.x, y: state.y, facing: state.facing,
    money: state.money,
    badges: state.badges, beatenTrainers: state.beatenTrainers,
    party: state.party, box: state.box, bag: state.bag,
    candies: state.candies || {},
    balls: { greatball: (state.balls && state.balls.greatball) || 0 },
    encounters: state.encounters || {},
    wildSeen: state.wildSeen || 0,
    caught: state.caught,
    battledToday: !!state.battledToday,
  };
}

export class GameController {
  constructor(dex, world, state, { onExit, onSave, conn } = {}) {
    this.dex = dex;
    this.world = world;
    this.state = state;
    this.onExitGame = onExit || (() => {});
    // onSave(save, immediate): persist the player's progress. Debounced for
    // frequent events (steps) and forced for important ones (battles, buys).
    this.onSave = onSave || (() => {});
    // conn (optional): the live LobbyConnection. When present it drives
    // multiplayer presence + click-to-invite PvP (Task 17). The overworld's
    // `players` list is the single source of truth for who's on this map.
    this.conn = conn || null;
    this._inBattle = false;   // a PvP battle view is mounted
    this.root = el('div', { class: 'game' });
  }

  // Push the current state to the persistence layer. `immediate` bypasses any
  // debounce (used after battles, catches, purchases, map changes).
  persist(immediate = false) {
    try { this.onSave(serializeSave(this.state), immediate); } catch { /* ignore */ }
  }

  start() {
    this.showOverworld();
    if (this.conn) {
      this.conn.onPush = (m) => this.onLobbyPush(m);
      this.sendPresence();
    }
    return this.root;
  }

  // ---- multiplayer presence + PvP (Task 17) ------------------------------
  // Tell the lobby where we are now (per-step + on map change). Cheap and
  // fire-and-forget; the server fans it out to peers on the same map.
  sendPresence() {
    if (this.conn) this.conn.sendPresence({ map: this.state.map, x: this.state.x, y: this.state.y, facing: this.state.facing });
  }

  peerName(id) {
    const list = (this.ow && this.ow.players) || [];
    const p = list.find((q) => q.id === id);
    return p ? p.name : null;
  }

  // Lock/unlock overworld input while a modal (invite / battle) owns the screen.
  lockOw(lock) {
    if (this.ow) { this.ow.busy = !!lock; if (lock) this.ow.held = null; }
  }

  // Route a presence/invite/PvP push from the server.
  onLobbyPush(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'peers': if (this.ow) this.ow.renderPlayers(m.list || []); break;
      case 'peerJoin': if (this.ow && m.peer) this.ow.upsertPeer(m.peer); break;
      case 'peerMove': if (this.ow) this.ow.upsertPeer({ id: m.id, x: m.x, y: m.y, facing: m.facing }); break;
      case 'peerLeave': if (this.ow) this.ow.removePeer(m.id); break;
      case 'chat': if (this.ow && m.text) this.ow.peerChat(m.id, m.text); break;
      case 'pvpInvite': this.onPvpInvite(m); break;
      case 'pvpDeclined': this.lockOw(false); this.closeOverlay(); if (this.ow) this.ow.say(`${this.peerName(m.byPlayerId) || 'They'} declined the battle.`); break;
      case 'matched': this.onPvpMatched(m); break;
      case 'pvpResult': this.onPvpResult(m); break;
      case 'evCandies': this.onEvCandies(m); break;
      case 'dayAdvanced': this.onDayAdvanced(m); break;
      case 'enterArena': this.onEnterArena(m); break;
      case 'tournamentState': this.onTournamentState(m); break;
      case 'spectate': this.onSpectate(m); break;
      case 'champion': this.onChampion(m); break;
      default: break;
    }
  }

  // Tapping a remote character opens their player card (name / money / team)
  // with the option to call them out for a battle.
  async onPlayerClick(p) {
    if (!this.conn || this._inBattle || !p) return;
    this.lockOw(true);
    this.showOverlay([
      el('h2', { class: 'pc-name', text: p.name || 'Player' }),
      el('div', { class: 'pvp-spinner' }),
      el('p', { text: 'Loading player…' }),
    ], 'player-card');
    let card;
    try { card = await this.conn.getPlayerCard(p.id); }
    catch { this.closeOverlay(); this.lockOw(false); if (this.ow) this.ow.say('Could not load that player.'); return; }
    if (!this._overlay || this._inBattle) return; // bailed out while loading
    this.showPlayerCard(p, card);
  }

  // Render the player card: avatar + name + money, the team (sprite + stats, no
  // moves), and a "Call for Battle" button that fires the PvP invite.
  showPlayerCard(p, card) {
    const team = (card.team || []).map((mon) => {
      const sp = this.dex.getSpecies(mon.species);
      const stats = this.monStats(mon, mon.level);
      return el('div', { class: `pc-mon${mon.shiny ? ' shiny' : ''}` }, [
        el('img', { class: 'pc-mon-sprite', src: spriteFront(sp.num, mon.shiny), alt: sp.name }),
        el('div', { class: 'pc-mon-info' }, [
          el('div', { class: 'pc-mon-head' }, [
            el('span', { class: 'pc-mon-name', text: sp.name + (mon.shiny ? ' ✦' : '') }),
            el('span', { class: 'pc-mon-lv', text: `Lv ${mon.level}` }),
          ]),
          el('div', { class: 'pc-stats' }, STAT_KEYS.map((k) =>
            el('span', { class: 'pc-stat' }, [el('b', { text: STAT_SHORT[k] }), el('span', { text: ` ${stats[k]}` })]))),
        ]),
      ]);
    });
    this.showOverlay([
      el('div', { class: 'pc-head' }, [
        el('span', { class: 'lb-char-sprite pc-avatar', style: `--sheet:url("${new URL(`assets/characters/${card.character || 'red'}.png`, document.baseURI).href}")` }),
        el('div', { class: 'pc-id' }, [
          el('h2', { class: 'pc-name', text: card.name || p.name || 'Player' }),
          el('span', { class: 'pc-money', text: `₽${(card.money || 0).toLocaleString('en-US')}` }),
        ]),
      ]),
      el('div', { class: 'pc-team' }, team.length ? team : [el('div', { class: 'pc-empty', text: 'No Pokémon yet.' })]),
      el('p', { class: 'pvp-sub', text: 'Winner +₽1000 · loser −₽1000 (balances may go negative).' }),
      el('div', { class: 'pvp-btns' }, [
        el('button', { class: 'primary', text: '⚔ Call for Battle', onclick: () => { this.conn.invitePvp(p.id); this.showInviteWaiting(p); } }),
        el('button', { class: 'secondary', text: 'Close', onclick: () => { this.closeOverlay(); this.lockOw(false); } }),
      ]),
    ], 'player-card');
  }

  showInviteWaiting(p) {
    this.showOverlay([
      el('h2', { text: 'Challenge sent' }),
      el('div', { class: 'pvp-spinner' }),
      el('p', { text: `Waiting for ${p.name || 'your opponent'} to accept…` }),
      el('div', { class: 'pvp-btns' }, [
        el('button', { class: 'secondary', text: 'Cancel', onclick: () => { this.conn.cancelPvp(); this.closeOverlay(); this.lockOw(false); } }),
      ]),
    ]);
  }

  onPvpInvite(m) {
    if (this._inBattle) { this.conn.declinePvp(m.fromPlayerId); return; }
    this.showOverlay([
      el('h2', { text: '⚔ Battle Challenge!' }),
      el('p', { text: `${m.fromName || 'A challenger'} wants to battle you!` }),
      el('p', { class: 'pvp-sub', text: 'Winner +₽1000 · loser −₽1000 (balances may go negative).' }),
      el('div', { class: 'pvp-btns' }, [
        el('button', { class: 'primary', text: 'Accept', onclick: () => { this.closeOverlay(); this.conn.acceptPvp(m.fromPlayerId); if (this.ow) this.ow.say(`Battle with ${m.fromName || 'your opponent'} starting…`); } }),
        el('button', { class: 'secondary', text: 'Decline', onclick: () => { this.closeOverlay(); this.lockOw(false); this.conn.declinePvp(m.fromPlayerId); } }),
      ]),
    ]);
    this.lockOw(true);
  }

  // Both sides received `matched`: mount the server-authoritative battle view.
  // A tournament match (m.tournament) auto-returns to the arena bracket when it
  // ends, rather than waiting for a manual "back" click.
  onPvpMatched(m) {
    if (this._inBattle) return;
    if (this.spectateView) this.closeSpectate();   // I was watching; now I'm fighting
    this.closeOverlay();
    this._inBattle = true;
    this.lockOw(true);
    this._hideTourneyPanel();
    const tournament = !!m.tournament;
    const adapter = this.conn.beginPvp();
    const view = new NetworkBattleView(this.dex, adapter, () => {
      // rawExit: stop routing engine frames, restore the overworld, resync.
      this.conn.endPvp();
      this._inBattle = false;
      this.restoreOverworld();
      this.lockOw(false);
      this.sendPresence();
      if (tournament) this._showTourneyPanel();   // back to the bracket
    });
    if (tournament) { view.autoExitMs = 2500; view.exitLabel = '← Back to Arena'; }
    this.pvpView = view; // dev handle
    this.ow.root.style.display = 'none';
    this.root.append(view.root);
    this._removeBattle = () => { try { view.root.remove(); } catch { /* ignore */ } };
    view.begin(m);
  }

  // The server settled the wager (authoritative). Adopt its money + flag, and —
  // if we won — earn EV candies for the opponent's team we defeated.
  onPvpResult(m) {
    const before = this.state.money || 0;
    if (typeof m.money === 'number') this.state.money = m.money;
    this.state.battledToday = true;
    if (Array.isArray(m.defeatedTeam) && m.defeatedTeam.length) {
      const msg = this.grantCandies(m.defeatedTeam);
      if (msg && this.ow) this.ow.say(msg);
    }
    if (this.ow) this.ow.renderHud();
    if (typeof m.money === 'number') this.queueMoneyFloat(this.state.money - before);
    this.persist(true);
  }

  // Tournament match win: the server tells us which team we beat → earn candies.
  onEvCandies(m) {
    if (!Array.isArray(m.species) || !m.species.length) return;
    const msg = this.grantCandies(m.species);
    if (msg && this.ow) this.ow.say(msg);
    this.persist(true);
  }

  // A new day dawned in week mode (Task 18). The server is authoritative on the
  // schedule + any daily penalty, so we adopt its config + money, reset our
  // local battle flag, and surface the news (a fresh route, the −₽ penalty, or
  // the end of the week).
  onDayAdvanced(m) {
    const cfg = m.config || {};
    const prevUnlocked = this.state.unlockedMap;
    if (typeof cfg.unlockedMap === 'number') this.state.unlockedMap = cfg.unlockedMap;
    if (typeof cfg.dayIndex === 'number') this.state.dayIndex = cfg.dayIndex;
    if (typeof cfg.weekLength === 'number') this.state.weekLength = cfg.weekLength;
    this.state.weekLocked = !!m.locked;
    this.state.battledToday = false;               // a clean slate for the new day
    if (m.penalty && typeof m.penalty.money === 'number') this.state.money = m.penalty.money;
    if (this.ow) this.ow.renderHud();
    this.persist(true);

    if (m.locked) {
      // The week ends in the arena tournament: the server's `enterArena` push
      // (arriving right after this) teleports us and opens the bracket. Without
      // an arena (shouldn't happen), fall back to the plain end-of-week screen.
      if (this.world.progression.arenaMap) { if (this.ow) this.ow.say('🏁 The week is over — to the arena for the tournament!'); return; }
      this.showWeekOver();
      return;
    }
    const day = (cfg.dayIndex || 0) + 1, of = cfg.weekLength || this.world.progression.mapCount;
    let note = `☀ Day ${day} of ${of} begins!`;
    if (this.state.unlockedMap > prevUnlocked) note += ` Route ${this.state.unlockedMap} is now open.`;
    if (m.penalty && m.penalty.delta < 0) note += ` You didn't battle yesterday — ₽${Math.abs(m.penalty.delta).toLocaleString('en-US')} fine!`;
    if (this.ow) this.ow.say(note);
  }

  // End-of-week lock: progression + PvP are closed; show the final balance.
  showWeekOver() {
    this.lockOw(true);
    this.showOverlay([
      el('h2', { text: "🏁 The week is over!" }),
      el('p', { text: 'All routes are closed and battles have ended.' }),
      el('p', { class: 'pvp-sub', text: `Your final balance: ₽${(this.state.money || 0).toLocaleString('en-US')}` }),
      el('div', { class: 'pvp-btns' }, [
        el('button', { class: 'secondary', text: 'View the map', onclick: () => { this.closeOverlay(); } }),
      ]),
    ]);
  }

  // ---- tournament arena (Task 19) ----------------------------------------
  // The server moved us to the arena and opened a bracket. Teleport there,
  // report presence (so the gather gate + spectator fan-out can see us), and
  // open the tournament panel.
  onEnterArena(m) {
    this.state.weekLocked = true;
    this.tourney = m.tournament || this.tourney || null;
    this._champion = null;
    if (this.spectateView) this.closeSpectate();
    const arena = m.map || this.world.progression.arenaMap;
    if (this.ow) { this.ow.players = []; this.goToMap(arena); }
    else { this.state.map = arena; this.state.x = m.x; this.state.y = m.y; }
    if (this.conn) this.conn.tournamentEnter();
    this._showTourneyPanel();
  }

  // Free mode: walking north off the final route enters the arena, where the
  // host can gather everyone for a tournament. Offline (no lobby) it's just a
  // quiet hall. The server answers `tournamentEnter` with a `tournamentState`.
  enterArenaFromNorth() {
    const arena = this.world.progression.arenaMap;
    if (!arena) { if (this.ow) this.ow.say('This is the final route.'); return; }
    if (this.ow) this.ow.say('You step into the grand tournament arena!');
    this.goToMap(arena);
    if (this.conn) this.conn.tournamentEnter();
  }

  // Fresh bracket snapshot from the server (gather/active/done).
  onTournamentState(m) {
    this.tourney = m.tournament || null;
    if (this._tourneyPanel && this._tourneyPanel.style.display !== 'none') this._renderTourneyPanel();
    else if (!this._inBattle && !this.spectateView && this.tourney) this._showTourneyPanel();
  }

  // A champion was crowned — celebrate (the bracket panel also shows it).
  onChampion(m) {
    this._champion = m;
    const mine = this.conn && m.playerId === this.conn.playerId;
    if (this._tourneyPanel) this._renderTourneyPanel();
    this.showOverlay([
      el('h2', { text: '🏆 Champion!' }),
      el('p', { text: mine ? 'You won the tournament — you are the arena champion!' : `${m.name || 'A challenger'} is the arena champion!` }),
      el('div', { class: 'pvp-btns' }, [
        el('button', { class: 'secondary', text: 'Close', onclick: () => { this.closeOverlay(); } }),
      ]),
    ]);
  }

  // ---- spectating a live match -------------------------------------------
  onSpectate(m) {
    if (this._inBattle) return;        // I'm a combatant; my own frames drive the battle view
    if (m.sub === 'events') {
      if (!this.spectateView) this.openSpectate(m);
      else this.spectateView.onFrame(m);
    } else if (m.sub === 'end') {
      if (this.spectateView) this.spectateView.onFrame(m);
    }
  }

  openSpectate(first) {
    if (this.spectateView) return;
    this._hideTourneyPanel();
    this.lockOw(true);
    if (this.ow) this.ow.root.style.display = 'none';
    const view = new SpectateView(this.dex, () => this.closeSpectate());
    this.spectateView = view; // dev handle
    this.root.append(view.root);
    view.begin(first);
  }

  closeSpectate() {
    if (!this.spectateView) return;
    try { this.spectateView.root.remove(); } catch { /* ignore */ }
    this.spectateView = null;
    if (this.ow) { this.ow.root.style.display = ''; this.ow.renderHud(); }
    this.lockOw(false);
    this._showTourneyPanel();
  }

  // ---- tournament panel (floating bracket + controls) --------------------
  _showTourneyPanel() {
    if (this._inBattle || this.spectateView || !this.tourney) return;
    if (!this._tourneyPanel) { this._tourneyPanel = el('div', { class: 'tourney-panel' }); this.root.append(this._tourneyPanel); }
    this._tourneyPanel.style.display = '';
    this._renderTourneyPanel();
  }

  _hideTourneyPanel() { if (this._tourneyPanel) this._tourneyPanel.style.display = 'none'; }

  _renderTourneyPanel() {
    const t = this.tourney; if (!t || !this._tourneyPanel) return;
    const myId = this.conn && this.conn.playerId;
    const isHost = myId && t.hostId === myId;
    const kids = [];
    const statusText = t.status === 'gathering' ? 'Gathering players…' : (t.status === 'active' ? 'Tournament underway' : 'Tournament complete');
    kids.push(el('div', { class: 'tp-head' }, [
      el('span', { class: 'tp-title', text: '🏆 Arena Tournament' }),
      el('span', { class: 'tp-status', text: statusText }),
    ]));

    if (t.status === 'gathering') {
      const present = t.present || [];
      const ready = new Set(t.ready || []);
      const rows = present.map((id) => {
        const nm = (id === myId ? (this.state.name || 'You') : (this.peerName(id) || 'Player'));
        return el('div', { class: 'tp-entrant' }, [
          el('span', { class: `tp-dot${ready.has(id) ? ' on' : ''}` }),
          el('span', { text: nm + (id === myId ? ' (you)' : '') }),
        ]);
      });
      kids.push(el('div', { class: 'tp-sub', text: `${present.length} player${present.length === 1 ? '' : 's'} in the arena · ${ready.size} ready` }));
      kids.push(el('div', { class: 'tp-entrants' }, rows));
      const btns = [];
      const iReady = ready.has(myId);
      btns.push(el('button', { class: iReady ? 'secondary' : 'primary', text: iReady ? '✓ Ready' : "I'm Ready", disabled: iReady, onclick: () => this.conn.tournamentReady() }));
      if (isHost) btns.push(el('button', { class: 'primary', text: '▶ Force Start', onclick: () => this.conn.tournamentStart() }));
      kids.push(el('div', { class: 'tp-btns' }, btns));
    } else {
      kids.push(this._renderBracket(t));
      if (t.status === 'active' && t.current) kids.push(el('div', { class: 'tp-now', text: `▶ Now playing: ${t.current.aName} vs ${t.current.bName}` }));
      if (t.status === 'done') kids.push(el('div', { class: 'tp-champ', text: `🏆 Champion: ${t.championName || '—'}` }));
    }
    this._tourneyPanel.innerHTML = '';
    this._tourneyPanel.append(...kids);
  }

  _renderBracket(t) {
    const myId = this.conn && this.conn.playerId;
    const rounds = t.rounds || [];
    const cols = rounds.map((round, ri) => {
      const head = (round.length === 1 && ri === rounds.length - 1 && rounds.length > 1) ? 'Final' : `Round ${ri + 1}`;
      const matches = round.map((m) => {
        const live = t.current && t.current.id === m.id;
        const slot = (id, name, bye) => el('div', {
          class: `tp-slot${(m.winner && m.winner === id) ? ' win' : ''}${(id && id === myId) ? ' me' : ''}`,
          text: name || (bye ? '— (bye)' : 'TBD'),
        });
        return el('div', { class: `tp-match${live ? ' live' : ''}${m.bye ? ' bye' : ''}` }, [
          slot(m.a, m.aName, false),
          slot(m.b, m.bName, m.bye),
        ]);
      });
      return el('div', { class: 'tp-round' }, [el('div', { class: 'tp-round-h', text: head }), ...matches]);
    });
    return el('div', { class: 'tp-bracket' }, cols);
  }

  // ---- modal overlay (shared by invite prompts + battle cards) -----------
  showOverlay(kids, modalClass = 'pvp-modal') {
    this.closeOverlay();
    this._overlay = el('div', { class: 'pvp-overlay' }, [el('div', { class: `panel ${modalClass}` }, kids)]);
    this.root.append(this._overlay);
    return this._overlay;
  }

  closeOverlay() { if (this._overlay) { this._overlay.remove(); this._overlay = null; } }

  showOverworld() {
    this.reconcileLevelMoves(); // backfill any level-up moves missed before this existed
    this.ow = new Overworld(this.dex, this.world, this.state, this.hooks());
    this.root.innerHTML = '';
    this.root.append(this.ow.mount());
  }

  hooks() {
    return {
      onExit: () => { this.persist(true); this.ow.destroy(); this.onExitGame(); },
      onStep: () => { this.persist(false); this.sendPresence(); },
      onProgress: () => this.persist(true),
      onPlayerClick: (p) => this.onPlayerClick(p),
      onChat: (text) => { if (this.conn) this.conn.sendChat(text); },
      onGrass: (ow) => this.onGrass(ow),
      onTrainer: async (ow, data) => this.startTrainerBattle(data),
      onGym: async (ow, side) => {
        if (this.badgeFor(side)) { ow.say('You have already earned this badge.'); return false; }
        const g = this.world.gyms[this.state.map][side];
        return this.startGymBattle(g, side);
      },
      onMart: async (ow) => this.openMart(ow),
      onBox: async (ow) => this.openBox(ow),
      onItems: async (ow) => this.openItems(ow),
      onPartyMon: async (ow, i) => this.openMonSummary(i),
      onPartyReorder: () => this.persist(true),
      onNorth: async (ow) => {
        if (this.state.weekLocked) { ow.say('The week is over — the routes are closed.'); return; }
        if (!this.bothGymsBeaten()) { ow.say('The path north is blocked — defeat both Gym Leaders to open it.'); return; }
        if (this.state.map >= this.world.progression.mapCount) { this.enterArenaFromNorth(); return; }
        if (this.state.map + 1 > this.unlockedMapCap()) { ow.say("The next route hasn't opened yet — it unlocks on the next day."); return; }
        ow.say('You head north to the next route…');
        this.goToMap(this.state.map + 1);
      },
      onSouth: async (ow) => {
        // Walk back down to the previous route (all your progress there is kept).
        if (this.state.weekLocked) { ow.say('The week is over — the routes are closed.'); return; }
        if (this.state.map <= 1) return; // already on the first route
        ow.say('You head south to the previous route…');
        this.goToMap(this.state.map - 1, 'north');
      },
    };
  }

  // ---- progression helpers ----------------------------------------------
  // Current map's level cap = the route's "Max Lv" (highest level present on its
  // trainers/gyms, shown in the HUD). Pokémon can level up to this but no further
  // until a higher-cap route is reached; battle stats are also clamped to it.
  mapCap(map = this.state.map) {
    const p = this.world.progression.maps.find((m) => m.map === map);
    return p ? (p.maxLevel ?? p.cap ?? 100) : 100;
  }

  badgeFor(side, map = this.state.map) {
    const b = (this.state.badges && this.state.badges[map]) || {};
    return !!b[side];
  }

  bothGymsBeaten(map = this.state.map) {
    return this.badgeFor('kanto', map) && this.badgeFor('johto', map);
  }

  // Highest route currently reachable. Week mode reveals one route per day; free
  // mode (and the standalone preview, where unlockedMap is unset) opens them all.
  unlockedMapCap() {
    return this.state.unlockedMap || this.world.progression.mapCount;
  }

  addMoney(amt) { this.state.money = (this.state.money || 0) + amt; this.queueMoneyFloat(amt); }

  // Float a ±money chip on the HUD. If a battle view is covering the overworld,
  // accumulate the delta and flush it when we return (so the player sees the
  // reward appear back on the map).
  queueMoneyFloat(amt) {
    if (!amt) return;
    if (this.ow && !this._removeBattle) this.ow.moneyFloat(amt);
    else this._pendingMoney = (this._pendingMoney || 0) + amt;
  }

  // Brief full-screen flash used as a battle enter/exit transition.
  flashTransition() {
    const f = document.createElement('div');
    f.className = 'screen-flash';
    this.root.append(f);
    void f.offsetWidth;
    f.classList.add('on');
    setTimeout(() => f.remove(), 480);
  }

  // ---- catchable encounters (per-map) -----------------------------------
  // The per-map allowance as a number (Infinity if unlimited).
  encounterMax() { return encounterMaxValue(this.state.encounterSetting); }

  // Catchable encounters remaining on a map (lazily defaults to the full max).
  encountersLeft(map = this.state.map) {
    const max = this.encounterMax();
    if (max === Infinity) return Infinity;
    const e = this.state.encounters || {};
    return e[map] != null ? e[map] : max;
  }

  // Grant a map's encounter allowance the FIRST time it's visited (per-map pool).
  grantMapEncounters(mapId) {
    const max = this.encounterMax();
    if (max === Infinity) return;
    const e = this.state.encounters || (this.state.encounters = {});
    if (e[mapId] == null) e[mapId] = max;
  }

  // Spend one catchable encounter on a map (any wild encounter outcome). Floors
  // at 0 — beyond that you can still battle wild Pokémon, just not catch them.
  consumeEncounter(map = this.state.map) {
    const max = this.encounterMax();
    if (max === Infinity) return;
    const e = this.state.encounters || (this.state.encounters = {});
    const cur = e[map] != null ? e[map] : max;
    e[map] = Math.max(0, cur - 1);
  }

  // Can the player still catch on this map? (Encounters remaining > 0.)
  canCatch(map = this.state.map) { return this.encountersLeft(map) > 0; }

  // Move to a map. `entry` is the spawn point: 'spawn' (south, when arriving from
  // the previous route) or 'north' (top, when coming back down from the next).
  goToMap(mapId, entry = 'spawn') {
    this.grantMapEncounters(mapId); // one-time per-map catchable-encounter pool
    if (this.ow) this.ow.players = []; // drop the old map's remote actors
    this.ow.goToMap(mapId, entry);
    this.ow.renderHud();
    this.persist(true);
    this.sendPresence();               // server replies with the new map's peers
  }

  // Each grass step rolls for an encounter.
  async onGrass(ow) {
    if (Math.random() >= this.world.progression.encounterStepRate) return;
    const enc = this.rollEncounter();
    await this.startWild(enc);
  }

  rollEncounter() {
    const list = this.world.encounters[this.state.map];
    const total = list.reduce((s, e) => s + e.weight, 0);
    let r = Math.random() * total;
    let chosen = list[0];
    for (const e of list) { r -= e.weight; if (r <= 0) { chosen = e; break; } }
    // The first three wild encounters of the game ramp 3 → 4 → 5 (a gentle
    // onboarding); after that, levels are random within the route's band.
    const SCRIPTED = [3, 4, 5];
    const seen = this.state.wildSeen || 0;
    const level = seen < SCRIPTED.length ? SCRIPTED[seen] : randint(chosen.min, chosen.max);
    this.state.wildSeen = seen + 1;
    const shiny = Math.random() < 1 / this.world.progression.shinyRate;
    return { species: chosen.species, name: chosen.name, level, rarity: chosen.rarity, shiny };
  }

  startWild(enc) {
    return new Promise((resolve) => {
      const speciesName = this.dex.getSpecies(enc.species).name;
      const config = {
        kind: 'wild',
        controllers: ['human', 'ai'],
        names: [this.state.name || 'You', `Wild ${speciesName}`],
        teams: [this.partySets(), [{ species: enc.species, level: enc.level, shiny: enc.shiny, moves: this.dex.defaultMoves(enc.species, enc.level) }]],
      };
      const wild = {
        rarity: enc.rarity,
        shiny: enc.shiny,
        balls: this.state.balls,           // Poké Ball is Infinity (free); Great Ball is counted
        canCatch: this.canCatch(),         // gated by this map's remaining encounters
        progression: this.world.progression,
        catchChance: (hpPct, status, ball) => catchChance(this.world.progression, enc.rarity, hpPct, status, ball),
        makeCaughtSet: () => makeMon(this.dex, enc.species, enc.level, enc.shiny),
        onDone: (res) => { this.afterWild(res, enc); resolve(); },
      };
      const view = new WildBattleView(this.dex, config, () => {}, wild);
      this.wildView = view; // dev handle
      this.mountBattleView(view);
    });
  }

  afterWild(res, enc) {
    // Any wild encounter — caught, defeated, ran, lost or quit — spends one of
    // this map's catchable encounters (floored at 0).
    this.consumeEncounter(this.state.map);
    this.restoreOverworld();
    // EXP for defeating or catching the wild Pokémon (full heal is automatic:
    // party sets are rebuilt at full HP/PP each battle).
    const won = res.outcome === 'defeated' || res.outcome === 'caught'; // wild KO is 'defeated'
    const expMsg = won && enc ? this.awardBattleExp([enc.level], this.battleParticipants(this.wildView)) : '';
    const candyMsg = won && enc ? this.grantCandies([enc.species]) : '';
    const extra = [expMsg, candyMsg].filter(Boolean).join(' · ');
    if (res.outcome === 'caught' && res.caughtSet) this.addPokemon(res.caughtSet);
    if (res.outcome === 'caught') this.ow.say(`${this.dex.getSpecies(res.caughtSet.species).name} was added to your team!${extra ? ` · ${extra}` : ''}`);
    else if (res.outcome === 'defeated') this.ow.say(extra || 'The wild Pokémon fainted.');
    else if (res.outcome === 'ran') this.ow.say('Got away safely.');
    else if (res.outcome === 'lost') this.ow.say('You were overwhelmed — but everyone was healed up.');
    else this.ow.say('');
    this.ow.renderPartyBar(); // reflect new levels / a caught member
    this.state.battledToday = true; // any wild encounter counts as a battle
    this.persist(true);
    this.flushEvoToasts();    // celebrate any evolution(s)
    this.processLearnQueue(); // prompt for any level-up moves that need a slot
  }

  // ---- trainer & gym battles --------------------------------------------
  // Returns a Promise<boolean> (won) so the overworld marks the trainer beaten.
  // First shows a pre-battle card (opponent + team + reward); the player chooses
  // to battle or back out (which resolves false, leaving the trainer in place).
  startTrainerBattle(data) {
    return new Promise((resolve) => {
      const reward = data.reward ?? this.world.progression.rewards.trainer;
      const foe = `${data.class} ${data.name}`;
      const start = () => {
        const config = {
          kind: 'trainer',
          controllers: ['human', 'ai'],
          names: [this.state.name || 'You', foe],
          teams: [this.partySets(), this.enemyTeam(data.party)],
        };
        const view = new TrainerBattleView(this.dex, config, {
          winTitle: 'Victory!',
          winSub: `You defeated ${foe} and earned ₽${reward.toLocaleString('en-US')}!`,
          loseTitle: 'You were defeated…',
          loseSub: 'Your team was fully healed.',
          onDone: (res) => {
            let expMsg = '', candyMsg = '';
            if (res.outcome === 'won') {
              this.addMoney(reward);
              expMsg = this.awardBattleExp((data.party || []).map((p) => p.level), this.battleParticipants(this.battleView));
              candyMsg = this.grantCandies((data.party || []).map((p) => p.species));
            }
            if (res.outcome !== 'lost') this.state.battledToday = true;
            this.restoreOverworld();
            const extra = [expMsg, candyMsg].filter(Boolean).join(' · ');
            this.ow.say(res.outcome === 'won'
              ? `You defeated ${foe}! +₽${reward.toLocaleString('en-US')}${extra ? ` · ${extra}` : ''}`
              : 'You were defeated — but everyone was healed up.');
            this.persist(true);
            this.flushEvoToasts();
            this.processLearnQueue();
            resolve(res.outcome === 'won');
          },
        });
        this.battleView = view; // dev handle
        this.mountBattleView(view);
      };
      this.showBattleCard({
        label: 'Trainer Battle', who: foe, sub: `${data.class} wants to battle!`,
        team: data.party, reward,
        onBattle: () => { this.closeOverlay(); start(); },
        onCancel: () => { this.closeOverlay(); if (this.ow) this.ow.say(`You walked away from ${foe}.`); resolve(false); },
      });
    });
  }

  // Returns a Promise<boolean> (won) so the overworld records the badge.
  startGymBattle(g, side) {
    return new Promise((resolve) => {
      const reward = g.reward ?? this.world.progression.rewards.gym;
      const start = () => {
        const config = {
          kind: 'trainer',
          controllers: ['human', 'ai'],
          names: [this.state.name || 'You', g.leader],
          teams: [this.partySets(), this.enemyTeam(g.team)],
        };
        const view = new TrainerBattleView(this.dex, config, {
          winTitle: `${g.leader} defeated!`,
          winSub: `You earned the ${g.gymType}-type Badge and ₽${reward.toLocaleString('en-US')}!`,
          loseTitle: 'You were defeated…',
          loseSub: `${g.leader} is still the ${g.gymType} Gym Leader. Train up and try again!`,
          onDone: (res) => {
            let expMsg = '', candyMsg = '';
            if (res.outcome === 'won') {
              this.addMoney(reward); this.ow.setBadge(side, true);
              expMsg = this.awardBattleExp((g.team || []).map((t) => t.level), this.battleParticipants(this.battleView));
              candyMsg = this.grantCandies((g.team || []).map((t) => t.species));
            }
            this.restoreOverworld();
            const extra = [expMsg, candyMsg].filter(Boolean).join(' · ');
            if (res.outcome === 'won') {
              this.ow.say((this.bothGymsBeaten()
                ? `You beat ${g.leader}! Both badges earned — the path north is open!`
                : `You beat ${g.leader} and earned a badge! +₽${reward.toLocaleString('en-US')}`) + (extra ? ` · ${extra}` : ''));
            } else this.ow.say(`${g.leader} was too strong this time. Train up and try again!`);
            this.flushEvoToasts();
            this.processLearnQueue();
            resolve(res.outcome === 'won');
          },
        });
        this.battleView = view; // dev handle
        this.mountBattleView(view);
      };
      this.showBattleCard({
        label: `${g.gymType}-type Gym`, who: g.leader, sub: `${g.gymType} Gym Leader · Badge on the line`,
        team: g.team, reward, accent: TYPE_COLORS[g.gymType],
        onBattle: () => { this.closeOverlay(); start(); },
        onCancel: () => { this.closeOverlay(); if (this.ow) this.ow.say(`You step back from ${g.leader}'s gym.`); resolve(false); },
      });
    });
  }

  // Pre-battle card shown before trainer/gym fights: opponent identity, their
  // full team (sprite + species + level), the reward, and Battle / Back buttons.
  showBattleCard({ label, who, sub, team, reward, accent, onBattle, onCancel }) {
    const mons = (team || []).map((p) => {
      const sp = this.dex.getSpecies(p.species);
      return el('div', { class: 'bc-mon' }, [
        el('img', { class: 'bc-mon-sprite', src: spriteFront(sp.num), alt: sp.name }),
        el('span', { class: 'bc-mon-name', text: sp.name }),
        el('span', { class: 'bc-mon-lv', text: `Lv ${p.level}` }),
      ]);
    });
    const count = (team || []).length;
    this.showOverlay([
      el('div', { class: 'bc-banner', style: accent ? `--bc:${accent}` : null }, [
        el('span', { class: 'bc-label', text: label }),
        el('h2', { class: 'bc-who', text: who }),
        sub ? el('span', { class: 'bc-sub', text: sub }) : null,
      ]),
      el('div', { class: 'bc-team-h', text: count === 1 ? '1 Pokémon' : `${count} Pokémon` }),
      el('div', { class: 'bc-team' }, mons),
      reward ? el('p', { class: 'pvp-sub', text: `Reward: ₽${reward.toLocaleString('en-US')}` }) : null,
      el('div', { class: 'pvp-btns' }, [
        el('button', { class: 'primary', text: '⚔ Battle!', onclick: onBattle }),
        el('button', { class: 'secondary', text: '← Back', onclick: onCancel }),
      ]),
    ], 'battle-card');
  }

  // Enemy "sets" for the engine (clone so the engine can't mutate world data).
  // Opponents carry no IVs/EVs, so the engine gives them average (15) genes and
  // zero EVs — un-trained, like real wild Pokémon — vs the player's EV-trained team.
  enemyTeam(party) {
    // Trainers & gym leaders use median IVs (15 across the board); EVs come from
    // the world data (level-scaled — spread for trainers, focused for gyms).
    return party.map((p) => ({
      species: p.species, level: p.level, moves: (p.moves || []).slice(), shiny: !!p.shiny,
      ivs: { ...DEFAULT_IVS }, evs: p.evs ? { ...p.evs } : { ...ZERO_EVS },
    }));
  }

  // ---- battle mount/unmount ---------------------------------------------
  // Hide the overworld, show the battle view, and run it. The view's own
  // onDone/result handler calls restoreOverworld() when the player continues.
  mountBattleView(view) {
    this.flashTransition();           // battle-start transition
    this.ow.root.style.display = 'none';
    this.root.append(view.root);
    this._removeBattle = () => { try { view.root.remove(); } catch { /* ignore */ } };
    view.run();
  }

  restoreOverworld() {
    if (this._removeBattle) { this._removeBattle(); this._removeBattle = null; }
    this.ow.root.style.display = '';
    this.flashTransition();           // battle-end transition
    this.ow.renderHud();
    this.ow.renderPartyBar();
    // Flush any rewards earned while the battle covered the map.
    if (this._pendingMoney) { this.ow.moneyFloat(this._pendingMoney); this._pendingMoney = 0; }
  }

  addPokemon(set) {
    if (this.state.party.length < this.world.progression.teamSize) {
      this.state.party.push(set);
    } else if (this.state.box.length < BOX_SIZE) {
      this.state.box.push(set);
    } else {
      // Team and PC Box both full: the newcomer takes the last box slot.
      this.state.box[this.state.box.length - 1] = set;
    }
    this.state.caught[toId(set.species)] = true;
  }

  // Which party slots actually fought (were sent out) in `view`'s battle, mapped
  // back to state.party by index (the battle team is a same-order clone). Null
  // if it can't be determined (then everyone gets full EXP, as a safe fallback).
  battleParticipants(view) {
    const side = view && view.battle && view.battle.sides && view.battle.sides[0];
    if (!side || !side.team) return null;
    const idx = [];
    side.team.forEach((p, i) => { if (p && p.participated) idx.push(i); });
    return idx.length ? idx : null;
  }

  // Grant battle EXP after a win. `foeLevels` lists the defeated opponents'
  // levels; `participants` are the party indices that fought (full EXP) — every
  // other party member still gets a share (BENCH_EXP_SHARE), like modern games.
  // Each member levels up (and evolves) as thresholds are crossed. Returns a
  // short summary for the toast, or '' if nobody leveled.
  awardBattleExp(foeLevels, participants) {
    const gain = (foeLevels || []).reduce((s, lv) => s + Math.max(1, Math.round(lv * EXP_PER_FOE_LEVEL)), 0);
    if (gain <= 0) return '';
    const benchGain = Math.max(1, Math.round(gain * BENCH_EXP_SHARE));
    const fought = participants ? new Set(participants) : null;
    const cap = this.mapCap(); // route's max level — Pokémon can't grow past it here
    const leveled = [];
    const learnedNames = [];
    this.state.party.forEach((mon, i) => {
      if (mon.level >= cap) return; // at the route's max level: gains no EXP (bar stays full)
      const amount = !fought || fought.has(i) ? gain : benchGain;
      const before = mon.level;
      mon.exp = (mon.exp || 0) + amount;
      while (mon.level < cap && mon.exp >= expToNext(mon.level)) {
        mon.exp -= expToNext(mon.level);
        mon.level += 1;
      }
      if (mon.level >= cap) mon.exp = 0; // hit the route cap — hold here (bar shows full)
      if (mon.level > before) {
        const name = this.monName(mon);
        const { evolvedName, learned } = this.applyLevelGains(mon, before, i); // evolve + learn moves
        leveled.push(`${evolvedName || name} →Lv ${mon.level}`); // evolutions get their own toast
        learnedNames.push(...learned);
      }
    });
    if (!leveled.length) return '';
    sfx.play('levelup');
    const learnNote = learnedNames.length ? ` · Learned ${learnedNames.slice(0, 3).join(', ')}${learnedNames.length > 3 ? '…' : ''}` : '';
    return `${leveled.length} Pokémon leveled up! (${leveled.slice(0, 3).join(', ')}${leveled.length > 3 ? '…' : ''})` + learnNote;
  }

  // Party as engine "sets" (shallow clones so the engine can't mutate state).
  // Each mon's effective level is clamped to the current map's cap, so you
  // can't over-level a route — stats are recomputed at the capped level.
  partySets() {
    const cap = this.mapCap();
    return this.state.party.map((p) => ({ ...p, level: Math.min(p.level, cap) }));
  }

  // ---- mart & bag --------------------------------------------------------
  // Items for sale on the current map.
  martInventory() { return this.world.mart[this.state.map] || []; }

  // Resolve an item id to its catalog definition (search every map's shelf).
  itemDef(id) {
    if (!this._itemIndex) {
      this._itemIndex = {};
      for (const list of Object.values(this.world.mart)) for (const it of list) this._itemIndex[it.id] = it;
    }
    return this._itemIndex[id] || { id, name: id, kind: 'misc' };
  }

  // How many of a purchasable item the player currently holds.
  ownedCount(item) {
    if (item.kind === 'ball') return this.state.balls.greatball || 0;
    return this.state.bag[item.id] || 0;
  }

  // Buy one unit. Great Balls go to the ball pouch; everything else to the bag.
  buyItem(item) {
    const money = this.state.money || 0;
    if (item.reusable && (this.state.bag[item.id] || 0) > 0) return { ok: false, msg: `You already own ${item.name}.` };
    if (money < item.price) return { ok: false, msg: 'Not enough money!' };
    this.state.money = money - item.price;
    if (item.kind === 'ball') this.state.balls.greatball = (this.state.balls.greatball || 0) + 1;
    else this.state.bag[item.id] = (this.state.bag[item.id] || 0) + 1;
    this.persist(true);
    return { ok: true, msg: `Bought ${item.name}!` };
  }

  // Usable bag items (consumables) with their resolved definitions + counts.
  bagEntries() {
    const out = [];
    for (const [id, count] of Object.entries(this.state.bag || {})) {
      if (count > 0) out.push({ item: this.itemDef(id), count });
    }
    return out;
  }

  // ---- items & evolution -------------------------------------------------
  monName(mon) { return mon.nickname || this.dex.getSpecies(mon.species).name; }

  // Computed stats from IVs + EVs (legacy statBonus still honored for old saves).
  monStats(mon, level = mon.level) {
    const species = this.dex.getSpecies(mon.species);
    const s = computeStats(species, level, mon.ivs || DEFAULT_IVS, mon.evs || ZERO_EVS);
    if (mon.statBonus) for (const k of STAT_KEYS) if (mon.statBonus[k]) s[k] += mon.statBonus[k];
    return s;
  }

  // Use a bag item on a party member. Returns { ok, msg }.
  useItem(id, monIndex) {
    const count = this.state.bag[id] || 0;
    if (count <= 0) return { ok: false, msg: 'You have none left.' };
    const item = this.itemDef(id);
    const mon = this.state.party[monIndex];
    if (!mon) return { ok: false, msg: 'No Pokémon selected.' };
    let res;
    if (item.kind === 'levelup') res = this.applyRareCandy(mon, monIndex);
    else if (item.kind === 'stone') res = this.applyStone(mon, item.id);
    else res = { ok: false, msg: "It won't have any effect." };
    if (res.ok) { this.state.bag[id] = count - 1; this.persist(true); }
    return res;
  }

  // Raise a mon's EV in `stat` by up to `amount`, honoring the 252/stat and 510
  // total caps. Returns { added } = how many EVs were actually applied.
  addEV(mon, stat, amount) {
    mon.evs = mon.evs ? { ...ZERO_EVS, ...mon.evs } : { ...ZERO_EVS };
    const cur = mon.evs[stat] || 0;
    const total = STAT_KEYS.reduce((s, k) => s + (mon.evs[k] || 0), 0);
    const room = Math.max(0, Math.min(MAX_EV - cur, EV_TOTAL_MAX - total));
    const added = Math.max(0, Math.min(amount | 0, room));
    if (added > 0) mon.evs[stat] = cur + added;
    return { added };
  }

  // EV yield of a defeated wild Pokémon → which stat-candy, and how many. The
  // candy stat is the species' best base stat; stronger species drop more.
  evYield(speciesId) {
    const b = this.dex.getSpecies(speciesId).baseStats;
    let stat = STAT_KEYS[0];
    for (const k of STAT_KEYS) if (b[k] > b[stat]) stat = k;
    const bst = STAT_KEYS.reduce((s, k) => s + b[k], 0);
    const amount = bst >= 480 ? 3 : bst >= 360 ? 2 : 1;
    return { stat, amount };
  }

  // Grant EV candies for each defeated species (wild, trainer, gym or PvP) into
  // the player's stash. Returns a short "+N Stat candy" summary (aggregated by
  // stat), or '' if the list was empty.
  grantCandies(speciesList) {
    const c = this.state.candies || (this.state.candies = {});
    const gained = {};
    for (const sp of (speciesList || [])) {
      if (!sp) continue;
      const { stat, amount } = this.evYield(sp);
      c[stat] = (c[stat] || 0) + amount;
      gained[stat] = (gained[stat] || 0) + amount;
    }
    return Object.entries(gained).map(([stat, amt]) => `+${amt} ${STAT_LABEL[stat]} candy`).join(' · ');
  }

  // Apply `requested` EV candies of `stat` to party[i] (drag-drop). Consumes the
  // candies actually used; respects the EV caps. Returns { ok, msg, applied }.
  applyCandies(i, stat, requested) {
    const mon = this.state.party[i];
    if (!mon) return { ok: false, msg: 'No Pokémon selected.' };
    const candies = this.state.candies || (this.state.candies = {});
    const have = candies[stat] || 0;
    if (have <= 0) return { ok: false, msg: `You have no ${STAT_LABEL[stat]} candies.` };
    const want = Math.max(0, Math.min(requested | 0, have));
    const { added } = this.addEV(mon, stat, want);
    if (added <= 0) return { ok: false, msg: `${this.monName(mon)}'s ${STAT_LABEL[stat]} EVs are maxed.` };
    candies[stat] = have - added;
    this.persist(true);
    return { ok: true, applied: added, msg: `${this.monName(mon)} gained ${added} ${STAT_LABEL[stat]} EVs!` };
  }

  // Most candies of `stat` that could be applied to party[i] right now (for the
  // drag-drop amount picker): limited by candies held and the mon's EV room.
  candyRoom(i, stat) {
    const mon = this.state.party[i];
    if (!mon) return 0;
    const have = (this.state.candies || {})[stat] || 0;
    const evs = mon.evs || ZERO_EVS;
    const cur = evs[stat] || 0;
    const total = STAT_KEYS.reduce((s, k) => s + (evs[k] || 0), 0);
    return Math.max(0, Math.min(have, MAX_EV - cur, EV_TOTAL_MAX - total));
  }

  applyRareCandy(mon, monIndex) {
    if (mon.level >= 100) return { ok: false, msg: `${this.monName(mon)} is already at Lv 100.` };
    const cap = this.mapCap();
    if (mon.level >= cap) return { ok: false, msg: `${this.monName(mon)} is at this route's max level (Lv ${cap}). Reach the next route to grow further.` };
    const before = this.monName(mon);
    const fromLevel = mon.level;
    mon.level += 1;
    sfx.play('levelup');
    const { evolvedName, learned } = this.applyLevelGains(mon, fromLevel, monIndex);
    const learnNote = learned.length ? ` It learned ${learned.join(', ')}!` : '';
    return {
      ok: true,
      msg: (evolvedName ? `${before} grew to Lv ${mon.level} and evolved into ${evolvedName}!`
                        : `${before} grew to Lv ${mon.level}!`) + learnNote,
    };
  }

  applyStone(mon, stoneId) {
    const before = this.monName(mon);
    const evolved = this.stoneEvolve(mon, stoneId);
    if (!evolved) return { ok: false, msg: `It had no effect on ${before}.` };
    return { ok: true, msg: `${before} evolved into ${evolved}!` };
  }

  // ---- TM / HM teaching -------------------------------------------------
  // Can `mon` learn this TM/HM's move? Returns { ok, msg } (msg explains why not).
  tmLearnable(mon, item) {
    if (!item || !item.move) return { ok: false, msg: 'That item teaches no move.' };
    const mv = this.dex.getMove(item.move);
    const machine = this.dex.getLearnset(mon.species).machine || [];
    if (!machine.includes(item.move)) return { ok: false, msg: `${this.monName(mon)} can't learn ${mv.name}.` };
    if ((mon.moves || []).includes(item.move)) return { ok: false, msg: `${this.monName(mon)} already knows ${mv.name}.` };
    return { ok: true };
  }

  // Teach the TM/HM's move to party[monIndex]. If the mon already has 4 moves,
  // `replaceIndex` (0-3) is the slot to overwrite; otherwise the move is added.
  // Consumes a TM (HMs are reusable). Returns { ok, msg }.
  teachMove(id, monIndex, replaceIndex) {
    const count = this.state.bag[id] || 0;
    const item = this.itemDef(id);
    if (!item.reusable && count <= 0) return { ok: false, msg: 'You have none left.' };
    const mon = this.state.party[monIndex];
    if (!mon) return { ok: false, msg: 'No Pokémon selected.' };
    const chk = this.tmLearnable(mon, item);
    if (!chk.ok) return chk;
    const moveName = this.dex.getMove(item.move).name;
    mon.moves = (mon.moves || []).slice();
    let forgot = null;
    if (mon.moves.length < 4 && (replaceIndex == null || replaceIndex < 0)) {
      mon.moves.push(item.move);
    } else {
      const i = Math.max(0, Math.min(mon.moves.length - 1, replaceIndex | 0));
      forgot = this.dex.getMove(mon.moves[i]).name;
      mon.moves[i] = item.move;
    }
    if (!item.reusable) this.state.bag[id] = count - 1;
    this.persist(true);
    return { ok: true, msg: forgot ? `${this.monName(mon)} forgot ${forgot} and learned ${moveName}!` : `${this.monName(mon)} learned ${moveName}!` };
  }

  // Apply every level evolution the mon now qualifies for (handles multi-step).
  tryLevelEvolutions(mon) {
    let evolvedName = null;
    for (let guard = 0; guard < 5; guard++) {
      const entries = this.world.evolution[mon.species];
      if (!entries) break;
      const e = entries.find((x) => x.method === 'level' && mon.level >= x.level);
      if (!e) break;
      mon.species = toId(e.to);
      this.state.caught[mon.species] = true;
      evolvedName = this.dex.getSpecies(mon.species).name;
    }
    return evolvedName;
  }

  // Evolve a mon at iteration level `lv` (used while replaying gained levels so
  // move learning happens on the correct, possibly-evolved species).
  evolveAtLevel(mon, lv) {
    let evolvedName = null;
    for (let guard = 0; guard < 5; guard++) {
      const entries = this.world.evolution[mon.species];
      if (!entries) break;
      const e = entries.find((x) => x.method === 'level' && lv >= x.level);
      if (!e) break;
      const fromName = this.dex.getSpecies(mon.species).name;
      mon.species = toId(e.to);
      this.state.caught[mon.species] = true;
      const sp = this.dex.getSpecies(mon.species);
      evolvedName = sp.name;
      (this.pendingEvos || (this.pendingEvos = [])).push({ from: fromName, to: sp.name, num: sp.num });
    }
    return evolvedName;
  }

  // Show a celebratory toast for each evolution that just happened (drained).
  flushEvoToasts() {
    const q = this.pendingEvos;
    if (!q || !q.length || !this.ow) return;
    this.pendingEvos = [];
    sfx.play('evolve');
    for (const e of q) this.ow.evoToast(e.from, e.to, e.num);
  }

  // Replay every level a mon just gained (fromLevel+1 .. mon.level): evolve where
  // eligible, then learn that level's moves. Moves drop into free slots; when the
  // mon already knows 4, the move is queued (pendingLearns) for a keep/replace
  // decision shown later. Returns { evolvedName, learned:[names] }.
  applyLevelGains(mon, fromLevel, monIndex) {
    let evolvedName = null;
    const learned = [];
    const queue = this.pendingLearns || (this.pendingLearns = []);
    for (let lv = fromLevel + 1; lv <= mon.level; lv++) {
      const evo = this.evolveAtLevel(mon, lv);
      if (evo) evolvedName = evo;
      const ls = this.dex.getLearnset(mon.species);
      for (const e of ls.levelup) {
        if (e.level !== lv || !this.dex.getMove(e.move)) continue;
        mon.moves = (mon.moves || []).slice();
        if (mon.moves.includes(e.move)) continue;
        if (mon.moves.length < 4) { mon.moves.push(e.move); learned.push(this.dex.getMove(e.move).name); }
        else if (!queue.some((q) => q.monIndex === monIndex && q.move === e.move)) queue.push({ monIndex, move: e.move });
      }
    }
    return { evolvedName, learned };
  }

  // Apply one learn decision: replaceIndex 0-3 overwrites that slot; null/<0 means
  // "don't learn" (skip). Returns { ok, msg }.
  applyLearn(mon, move, replaceIndex) {
    const mv = this.dex.getMove(move);
    if (!mv) return { ok: false, msg: '' };
    mon.moves = (mon.moves || []).slice();
    if (mon.moves.includes(move)) return { ok: true, msg: `${this.monName(mon)} already knows ${mv.name}.` };
    if (replaceIndex == null || replaceIndex < 0) {
      if (mon.moves.length < 4) { mon.moves.push(move); return { ok: true, msg: `${this.monName(mon)} learned ${mv.name}!` }; }
      return { ok: true, msg: `${this.monName(mon)} did not learn ${mv.name}.` };
    }
    const i = Math.max(0, Math.min(mon.moves.length - 1, replaceIndex | 0));
    const forgot = this.dex.getMove(mon.moves[i]).name;
    mon.moves[i] = move;
    return { ok: true, msg: `${this.monName(mon)} forgot ${forgot} and learned ${mv.name}!` };
  }

  // One-time safety net: fill any empty move slots with level-up moves the mon
  // already qualifies for (covers Pokémon that leveled before move-learning
  // existed). Only fills free slots — never replaces — so it needs no prompt.
  reconcileLevelMoves() {
    const fix = (mon) => {
      if (!mon) return;
      mon.moves = (mon.moves || []).slice();
      const ls = this.dex.getLearnset(mon.species);
      const eligible = ls.levelup.filter((e) => e.level <= mon.level && this.dex.getMove(e.move)).map((e) => e.move);
      for (let k = eligible.length - 1; k >= 0 && mon.moves.length < 4; k--) {
        if (!mon.moves.includes(eligible[k])) mon.moves.push(eligible[k]);
      }
    };
    (this.state.party || []).forEach(fix);
    (this.state.box || []).forEach(fix);
  }

  // Show keep/replace prompts for every queued level-up move (overlay on the
  // overworld). Used after battles and after Rare Candy. Locks the overworld
  // while prompting, then refreshes the party bar / HUD.
  async processLearnQueue() {
    const q = this.pendingLearns || (this.pendingLearns = []);
    if (!q.length || !this.ow) return;
    this.lockOw(true);
    try {
      while (q.length) {
        const { monIndex, move } = q.shift();
        const mon = this.state.party[monIndex];
        if (!mon || (mon.moves || []).includes(move)) continue;
        if ((mon.moves || []).length < 4) { this.applyLearn(mon, move, -1); continue; }
        await this.promptLearnMove(mon, move);
      }
    } finally {
      this.lockOw(false);
      this.persist(true);
      if (this.ow) { this.ow.renderPartyBar(); this.ow.renderHud(); }
    }
  }

  // One keep/replace dialog. Resolves once the player picks a slot to forget or
  // declines. No backdrop dismissal — a choice is required (like the games).
  promptLearnMove(mon, move) {
    return new Promise((resolve) => {
      const newMv = this.dex.getMove(move);
      const meta = (mv) => `${mv.type}${mv.basePower ? ` · ${mv.basePower} BP` : ''}`;
      let overlay;
      const close = () => { if (overlay) overlay.remove(); resolve(); };
      const pick = (i) => { const r = this.applyLearn(mon, move, i); if (this.ow) this.ow.say(r.msg); close(); };
      const skip = () => { if (this.ow) this.ow.say(`${this.monName(mon)} did not learn ${newMv.name}.`); close(); };
      const moveBtns = (mon.moves || []).map((mid, i) => {
        const mv = this.dex.getMove(mid);
        return el('button', { class: 'teach-move', style: `border-left:6px solid ${TYPE_COLORS[mv.type] || '#888'}`, onclick: () => pick(i) }, [
          el('span', { class: 'tm-name', text: mv.name }), el('span', { class: 'tm-meta', text: meta(mv) }),
        ]);
      });
      const panel = el('div', { class: 'panel menu-panel learn-panel' }, [
        el('div', { class: 'menu-head' }, [
          el('img', { class: 'learn-sprite', src: spriteFront(this.dex.getSpecies(mon.species).num, mon.shiny), alt: '' }),
          el('h3', { text: `${this.monName(mon)} wants to learn ${newMv.name}!` }),
        ]),
        el('div', { class: 'learn-new', text: `New move: ${newMv.name} · ${meta(newMv)}` }),
        el('div', { class: 'learn-q', text: 'But it already knows 4 moves. Forget one to make room?' }),
        el('div', { class: 'teach-moves' }, moveBtns),
        el('button', { class: 'ghost learn-skip', text: `Don't learn ${newMv.name}`, onclick: skip }),
      ]);
      overlay = el('div', { class: 'ow-overlay learn-overlay' }, [panel]);
      this.ow.root.append(overlay);
    });
  }

  // Evolve via a matching stone; returns the new species name or null.
  stoneEvolve(mon, stoneId) {
    const entries = this.world.evolution[mon.species];
    if (!entries) return null;
    const e = entries.find((x) => x.method === 'stone' && x.item === stoneId);
    if (!e) return null;
    const fromName = this.dex.getSpecies(mon.species).name;
    mon.species = toId(e.to);
    this.state.caught[mon.species] = true;
    const sp = this.dex.getSpecies(mon.species);
    (this.pendingEvos || (this.pendingEvos = [])).push({ from: fromName, to: sp.name, num: sp.num });
    return sp.name;
  }

  // ---- party / box management -------------------------------------------
  movePartyToBox(i) {
    if (this.state.party.length <= 1) return { ok: false, msg: 'You must keep at least one Pokémon.' };
    if (this.state.box.length >= BOX_SIZE) return { ok: false, msg: `Your PC Box is full (${BOX_SIZE}). Release one first.` };
    const [mon] = this.state.party.splice(i, 1);
    this.state.box.push(mon);
    this.persist(true);
    return { ok: true, msg: `${this.monName(mon)} was moved to the PC Box.` };
  }

  // Release (permanently delete) the PC Box Pokémon at index i.
  releaseFromBox(i) {
    const mon = this.state.box[i];
    if (!mon) return { ok: false, msg: 'No Pokémon there.' };
    this.state.box.splice(i, 1);
    this.persist(true);
    return { ok: true, msg: `${this.monName(mon)} was released. Bye-bye!` };
  }

  moveBoxToParty(i) {
    if (this.state.party.length >= this.world.progression.teamSize) return { ok: false, msg: 'Your party is full (6).' };
    const [mon] = this.state.box.splice(i, 1);
    this.state.party.push(mon);
    this.persist(true);
    return { ok: true, msg: `${this.monName(mon)} joined your party.` };
  }

  // ---- overlays (mart / menu) -------------------------------------------
  // Both return a Promise that resolves when the overlay closes, so the
  // overworld keeps input locked (busy) while a shop/menu is open.
  openMart(ow) {
    return new Promise((resolve) => {
      const view = new MartView(this, () => { view.root.remove(); ow.renderHud(); resolve(); });
      this.martView = view; // dev handle
      ow.root.append(view.root);
    });
  }

  // PC Box: manage party ↔ box (transfers + summaries). Items: use bag items on
  // a party member. Both lock overworld input until closed and refresh the
  // always-on party bar (transfers/evolutions can change the team).
  openBox(ow) {
    return new Promise((resolve) => {
      const view = new PartyMenu(this, () => { view.root.remove(); ow.renderHud(); ow.renderPartyBar(); this.flushEvoToasts(); resolve(); }, { tab: 'box' });
      this.menuView = view; // dev handle
      ow.root.append(view.root);
    });
  }

  openItems(ow) {
    return new Promise((resolve) => {
      const view = new PartyMenu(this, () => { view.root.remove(); ow.renderHud(); ow.renderPartyBar(); this.flushEvoToasts(); resolve(); }, { tab: 'items' });
      this.menuView = view; // dev handle
      ow.root.append(view.root);
    });
  }

  // Read-only summary popup for a party member (opened from the party bar).
  openMonSummary(i) { return this.showMonSummary(this.state.party[i]); }

  // Rich read-only summary overlay for ANY mon — party or PC box. Shows stats,
  // IVs, EVs, evolution paths and moves (the full panel). Resolves when closed.
  showMonSummary(mon) {
    return new Promise((resolve) => {
      if (!mon) { resolve(); return; }
      const species = this.dex.getSpecies(mon.species);
      const cap = this.mapCap();
      const capped = mon.level > cap;
      const level = capped ? cap : mon.level;
      const stats = this.monStats(mon, level);
      const close = () => { overlay.remove(); resolve(); };
      const types = el('span', { class: 'mn-types' }, species.types.map((t) =>
        el('span', { class: 'typechip sm', text: t, style: `background:${TYPE_COLORS[t] || '#888'}` })));
      const statGrid = el('div', { class: 'mn-stats' }, STAT_KEYS.map((k) =>
        el('span', { class: 'mn-stat' }, [el('b', { text: STAT_SHORT[k] }), el('span', { text: ` ${stats[k]}` })])));

      // IVs (genetics, 0-31 per stat; 31 = perfect, shown green) and EVs (earned
      // via candies/vitamins, 0-252 per stat with a 510 total).
      const ivs = mon.ivs || DEFAULT_IVS;
      const evs = mon.evs || ZERO_EVS;
      const bar = (cls, v, max) => el('div', { class: 'mn-iv-bar' }, [el('div', { class: cls, style: `width:${Math.round((v / max) * 100)}%` })]);
      const ivGrid = el('div', { class: 'mn-ivs' }, STAT_KEYS.map((k) => {
        const v = Math.max(0, Math.min(31, ivs[k] ?? 0));
        return el('div', { class: `mn-iv${v >= 31 ? ' perfect' : ''}`, title: `${STAT_SHORT[k]} IV ${v}/31` }, [
          el('b', { class: 'mn-iv-lbl', text: STAT_SHORT[k] }), bar('mn-iv-fill', v, 31), el('span', { class: 'mn-iv-val', text: `${v}` }),
        ]);
      }));
      const evGrid = el('div', { class: 'mn-ivs' }, STAT_KEYS.map((k) => {
        const v = evs[k] || 0;
        return el('div', { class: 'mn-iv', title: `${STAT_SHORT[k]} EV ${v}/252` }, [
          el('b', { class: 'mn-iv-lbl', text: STAT_SHORT[k] }), bar('mn-iv-fill ev', v, 252), el('span', { class: 'mn-iv-val', text: `${v}` }),
        ]);
      }));
      const ivTotal = STAT_KEYS.reduce((s, k) => s + Math.max(0, Math.min(31, ivs[k] || 0)), 0);
      const evTotal = STAT_KEYS.reduce((s, k) => s + (evs[k] || 0), 0);

      // Evolution paths, from the (customised) world evolution table.
      const evos = this.world.evolution[mon.species] || [];
      const evoEl = el('div', { class: 'mn-evos' }, evos.length ? evos.map((e) => {
        const toName = this.dex.getSpecies(e.to).name;
        const how = e.method === 'stone' ? `use ${this.itemDef(e.item).name}`
          : e.method === 'level' ? `reach Lv ${e.level}` : 'special';
        return el('div', { class: 'mn-evo' }, [el('span', { text: '→ ' }), el('b', { text: toName }), el('span', { text: ` · ${how}` })]);
      }) : [el('div', { class: 'mn-evo none', text: 'Does not evolve further.' })]);

      const moves = el('div', { class: 'mn-moves' }, (mon.moves || []).map((mid) => {
        const mv = this.dex.getMove(mid);
        return el('span', { class: 'mn-move', style: `border-left:6px solid ${TYPE_COLORS[mv.type] || '#888'}`, text: mv.name });
      }));
      const panel = el('div', { class: 'panel menu-panel mon-summary-panel' }, [
        el('div', { class: 'menu-head' }, [
          el('h3', { text: `${this.monName(mon)}${mon.shiny ? ' ✦' : ''}` }),
          el('span', { class: 'menu-wallet', text: `Lv ${mon.level}${capped ? ` (▼${cap})` : ''}` }),
          el('button', { class: 'ghost', text: '✕', onclick: close }),
        ]),
        el('div', { class: 'mn-card' }, [
          el('img', { class: 'mn-sprite', src: spriteFront(species.num, mon.shiny), alt: species.name }),
          el('div', { class: 'mn-meta' }, [types]),
        ]),
        el('div', { class: 'mn-summary' }, [
          el('div', { class: 'mn-summary-h', text: `Stats @ Lv ${level}` }), statGrid,
          el('div', { class: 'mn-summary-h', text: `IVs — ${ivTotal}/186` }), ivGrid,
          el('div', { class: 'mn-summary-h', text: `EVs — ${evTotal}/510` }), evGrid,
          el('div', { class: 'mn-summary-h', text: 'Evolution' }), evoEl,
          el('div', { class: 'mn-summary-h', text: 'Moves' }), moves,
        ]),
      ]);
      const overlay = el('div', { class: 'ow-overlay mon-summary-overlay', onclick: (e) => { if (e.target === overlay) close(); } }, [panel]);
      this.ow.root.append(overlay);
    });
  }
}
