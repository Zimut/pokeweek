# PokeWeek — Full Game Design

> Living design doc for turning the finished Gen-2 battle system into the full
> persistent multiplayer overworld game. Tracks confirmed decisions, content
> tables, architecture, and the build plan. Update as decisions change.

---

## 1. Vision

PokeWeek is a web-based, online multiplayer Pokémon game that gamifies playing
with friends. Players share a **lobby**, walk a chain of **7 condensed routes**
(maps), catch Pokémon, beat trainers and two gym leaders per map to advance, buy
gear at the mart, and fight each other for money. A **1-week mode** drips one new
map per day and ends in a **tournament** on an 8th map; a **free mode** opens all
maps at once (still badge-gated) and lets players come and go.

The Gen-2 battle engine + battle UI (251 Pokémon, HGSS sprites, move tooltips,
type-effectiveness cues, server-authoritative online battles) is **done** and is
reused for *every* battle type below.

---

## 2. Confirmed decisions

From the two clarification rounds:

| Topic | Decision |
|---|---|
| Overworld rendering | **Tile-grid (classic)** — step cell-to-cell, simple collision, clean position sync |
| Art style | **Hybrid** — clean styled tiles for routes + pixel-art overworld character sprites (prefer HGSS/SoulSilver, FireRed acceptable; best-effort sourcing) |
| 1-week "day" length | **Host-configurable** when creating lobby; default real 24h, shortenable for testing |
| Gym leaders (16 → 14) | **Drop 2** (Koga + Chuck) to keep the clean 2-gyms-per-map symmetry |
| Starting team | **Pick a starter** — 1 of the 6 classic starters at **Lv5** |
| Progression caps | **Keep a per-map level cap** — over-cap mons are **clamped** to the cap (stats recomputed) and **gain no EXP** above it; team size stays **6** |
| Build order | **Systems-first** — build each system across the whole game, then content |
| Map fit | **Whole map on one screen — no camera/scrolling**; responsive tile size |
| Poké Ball allowance | **Lobby setting**: 10–100 regular balls per map, or Infinite |
| Great Ball strength | **×5** catch rate |
| Shinies | **1/300** wild encounter, always **perfect IVs** |
| Starting money | **₽0** |

Always-true rules from the brief:

- **Full heal after every battle** (wild / trainer / gym / PvP). No Poké Center.
- **Regular Poké Balls** are a **lobby setting**: an allowance of **10–100 per map**, or **Infinite** (host's choice); the allowance refreshes each new map. **Great Balls** are bought at the mart and are far stronger (**×5 catch rate**).
- **Maps are badge-gated**: beat *both* gyms on a map to unlock the path to the next. In 1-week mode the next map *also* must have been time-unlocked.
- **Evolution** by **level and stones only**. Trade/friendship/other evolutions are reassigned a **level**. **Eevee is stone-only** (Fire/Water/Thunder) — **no Gen-2 eeveelutions** (Espeon/Umbreon are not in the game).
- **PvP stakes**: winner **+₽1000**, loser **−₽1000**; balances may go **negative**.
- **1-week daily duty**: a player who does not battle at least once in a day loses **₽2000** at day end.
- **Shinies**: every wild encounter has a **1/300** chance to be shiny; shinies always roll **perfect IVs**.

---

## 3. Glossary

- **Lobby** — a game instance with a unique 6-digit join code, a mode, and N players sharing persistent world state.
- **Map / Route** — one of 7 playable areas + the 8th tournament arena.
- **Badge** — proof of beating a map's gym; both badges on a map open its exit.
- **Day** (1-week mode) — a host-configured real-time window; its end unlocks the next map and applies daily penalties.

---

## 4. World model

### 4.1 Common map layout (all 7 routes identical in structure, different content)

```
              [ EXIT / PATH NORTH → next map ]              (locked until both badges)
   ┌─────────────────────────────────────────────────────┐
   │ [GYM-Kanto]                              [GYM-Johto] │  top corners
   │  T                                              T    │  ┐
   │  T                                              T    │  │
   │  T                 ┌───────────┐                T    │  │
   │  T                 │   GRASS    │                T    │  │ left column of 10
   │  T                 │   PATCH    │                T    │  │  + right column of 10
   │  T                 └───────────┘                T    │  │  (20 trainers total)
   │  T                                              T    │  │
   │  T                 [ POKé MART ]                T    │  │
   │  T                                              T    │  ┘
   └────────────────[ ENTRANCE / PATH SOUTH ]─────────────┘  (from previous map)
```

The **entire map fits a single screen — no camera, no scrolling.**

Elements present on every map:
1. **Central grass patch** — wild encounters, species by rarity weight + level band.
2. **20 trainers** — a single vertical column of **10 on the left edge** and **10 on the right edge**, spanning the map height. Beating one removes it permanently; pays money.
3. **Poké Mart** — buy items (power-up items, TMs/HMs, evolution stones, Great Balls).
4. **2 gyms** — top-left (Kanto leader) + top-right (Johto leader). Re-challengeable until won, then closed.
5. **North exit path** — to the next map; opens after both gyms are beaten (and time-unlocked in 1-week mode).
6. **South entrance** — spawn point / link back to previous map.

### 4.2 Tile grid spec

- **Whole map fits one screen — no camera/scrolling.** Fixed grid sized to hold the layout (proposal: **~21 wide × ~14 tall**, tunable to fit a column of 10 trainers per side plus gyms/mart/paths). Tile size is **responsive**: `tile = floor(min(viewportW/cols, viewportH/rows))`, so the full grid always fills the viewport without scrolling.
- Tile types: `void/wall`, `floor/path`, `grass` (triggers encounters), `mart-door`, `gym-door` (×2), `exit-north`, `entrance-south`, `trainer` (occupied/defeated), `decor` (solid).
- Collision: a tile is walkable unless it's a wall/decor/building/occupied-trainer tile.
- Movement: 4-directional, one tile per step, brief tween for smoothness. Facing direction tracked for sprite.
- Interaction: pressing into a `gym-door`/`mart-door`/`trainer`/`exit` triggers its action; stepping onto `grass` rolls an encounter.

### 4.3 The 8th map — tournament arena

- A single empty gym room. No wild grass, no trainers, no mart.
- **Free mode**: walk in/out freely.
- **1-week mode**: after the final day ends, all players are moved here and **locked** (no return).
- Hosts the bracket tournament (see §11).

---

## 5. Content tables (proposals — easy to edit)

### 5.1 Gym leader allocation (drop 2; difficulty-ordered, map 1 easiest)

Proposed drops: **Koga** (Kanto/Poison) and **Chuck** (Johto/Fighting). Keeps the most type-diverse, iconic set. *(Swap freely — e.g. trade Giovanni for Koga if you'd rather keep Poison.)*

| Map | Kanto gym | Johto gym | Notes |
|----:|-----------|-----------|-------|
| 1 | Brock (Rock) | Falkner (Flying) | as you specified |
| 2 | Misty (Water) | Bugsy (Bug) | |
| 3 | Lt. Surge (Electric) | Whitney (Normal) | |
| 4 | Erika (Grass) | Morty (Ghost) | |
| 5 | Sabrina (Psychic) | Jasmine (Steel) | |
| 6 | Blaine (Fire) | Pryce (Ice) | |
| 7 | Giovanni (Ground) | Clair (Dragon) | toughest |

### 5.2 Per-map level band + level cap (proposal)

"Wild band" = level range of grass encounters. "Cap" = max usable team level on that map (enforced in all battles started from that map).

| Map | Wild band | Gym leader ~level | **Level cap** |
|----:|:--------:|:-----------------:|:-------------:|
| 1 | 3–7   | ~10 | 15 |
| 2 | 8–12  | ~16 | 21 |
| 3 | 13–18 | ~22 | 27 |
| 4 | 18–24 | ~28 | 33 |
| 5 | 24–30 | ~34 | 39 |
| 6 | 30–36 | ~40 | 45 |
| 7 | 36–44 | ~48 | 52 |
| 8 (arena) | — | — | 55 |

Level-cap rule (confirmed): a Pokémon's **effective level is clamped** to the current map's cap in every battle started there — its stats are recomputed at the capped level. A Pokémon **at or above the cap gains no EXP** until you reach a higher-cap map. So you can't out-level a route; growth resumes when the next map raises the cap. (In free mode, revisiting an earlier map re-applies that map's lower clamp while you're on it.)

### 5.3 Wild encounter distribution

**Goal:** every **first-stage (base-form), non-legendary** Pokémon (#1–#251 minus the 11 legendaries and minus all evolved forms) is catchable somewhere across the 7 maps, placed to roughly match in-game progression, with poetic license for species that aren't naturally route-encounterable.

Method (authored as a data table, see §12):
- Each map has a weighted encounter list: `{ speciesId, weight, minLvl, maxLvl }`.
- Weights model rarity (common/uncommon/rare). Levels sit inside the map's wild band.
- Early maps: Pidgey/Rattata/Sentret/Caterpie/Weedle/Hoppip/etc.
  Mid maps: Growlithe/Vulpix/Machop/Abra/Geodude/Gastly/etc.
  Late maps: pseudo-legend bases (Larvitar, Dratini), Lapras, Tauros, Eevee, Porygon, fossil mons, etc.
- Stone/trade-evo *base* forms appear in grass; their evolutions come from leveling/stones (§8).
- Starters are obtainable as the starter pick; their lines otherwise evolve by level.

### 5.4 Trainers

- 20 per map = **140 trainers** total. Each is a themed party (1–4 mons) within the map's wild band, drawn from canon trainer classes that fit the route (Bug Catcher, Youngster, Lass, Hiker, Swimmer, Sailor, Psychic, Blackbelt, …).
- Reward (confirmed): **flat ₽200** per trainer defeated (not level-scaled).
- State: defeated trainers are stored per-player; they never respawn for that player.

### 5.5 Poké Mart inventory & prices (proposal; per-map availability grows)

| Item | Effect | Price (₽) |
|---|---|---|
| Great Ball | Stronger catch (×5) | 500 |
| HP Up / Protein / Iron / Calcium / Zinc / Carbos | +stat permanent boost | 1000 |
| Rare Candy | +1 level | 2000 |
| Fire/Water/Thunder/Leaf/Moon/Sun Stone | Stone evolution | 2000 |
| TMs | Teach move (TM list, Gen-2) | 2000 |
| HMs | Teach HM move | 2000 |

Higher-tier items unlock on later maps. Exact stat-item model (true EVs vs simplified flat boosts) flagged in §13.

### 5.6 Economy summary

| Event | Δ Money |
|---|---|
| Start | **₽0** |
| Beat trainer | **+₽200** (flat) |
| Beat gym leader | **+₽1000** |
| Win PvP | +₽1000 (taken from loser) |
| Lose PvP | −₽1000 (can go negative) |
| No battle in a day (1-week) | −₽2000 at day end |

---

## 6. Core gameplay loop

1. Join a lobby (create or enter code) → **pick character sprite + name + starter (Lv5)**.
2. Spawn on map 1 south entrance.
3. Walk; step in grass → wild encounter (battle + optional catch with unlimited balls / Great Balls).
4. Battle the 20 trainers and both gyms (full heal after each).
5. Spend money at the mart; evolve via level/stone; manage party (6) + PC box.
6. Beat both gyms → north exit opens → next map (if time-unlocked in 1-week mode).
7. Meet other lobby players on the map; click to challenge for ₽1000.
8. Reach map 8 → tournament.

---

## 7. Wild encounters & catching

- Encounter roll on each grass step (proposal: ~10–15% per step), species/level from the map's weighted table.
- Battle uses the existing engine. From the battle menu, **CATCH** throws a ball.
- **Ball supply is a lobby setting**: each player gets an allowance of **10–100 regular Poké Balls per map** (host picks), or **Infinite**. The per-map allowance **refreshes when you enter a new map**. **Great Balls** are a separate purchasable item (bag-tracked) with **×5** catch rate.
  - If a player runs out of balls on a map (non-Infinite), they can't catch again until the next map — unless they bought Great Balls.
- Catch chance: **rarity-tier catch rate** (common/uncommon/rare → higher→lower base) × **HP fraction** (lower HP = better) × **status bonus** (asleep/frozen best) × **ball bonus** (Great Ball ×5). Low odds just mean more throws — within your ball budget.
- **Shinies**: each wild mon rolls a **1/300** shiny chance; a shiny uses the shiny sprite and is generated with **perfect IVs (all 15s)**. *(Requires downloading HGSS shiny sprites — front + back — and a shiny-aware sprite lookup in `data.js`.)*
- Caught mon joins party (or PC box if party full). Full heal applies after the encounter ends.
- **Route encounter list UI**: each map exposes a panel (a "Route Info"/Pokédex-style screen from the menu) listing **which species can appear on this map, their % chance, and level range**, so players can plan what to hunt.

---

## 8. Evolution

- **Level evolutions**: trigger on level-up per evolution data.
- **Stone evolutions**: trigger when the matching stone (bought at mart) is used.
- **Eevee is stone-only**: Vaporeon (Water Stone), Jolteon (Thunder Stone), Flareon (Fire Stone). The Gen-2 friendship eeveelutions **Espeon and Umbreon are removed** (not obtainable in the game).
- **Trade / friendship / trade-with-item evolutions**: reassigned an **evolution level** so they evolve by leveling. Proposed levels:
  - Kadabra→Alakazam 37, Machoke→Machamp 37, Graveler→Golem 37, Haunter→Gengar 37 (trade)
  - Onix→Steelix 30, Scyther→Scizor 35, Seadra→Kingdra 42, Poliwhirl→Politoed 37, Slowpoke→Slowking 37, Porygon→Porygon2 30 (trade-with-item)
  - Friendship evos (Golbat→Crobat, Chansey→Blissey, baby evolutions like Igglybuff/Cleffa/Pichu/etc.) → assigned a level.
- **Data source:** pokedex.json (Showdown Gen-2) carries `evos/prevo/evoLevel/evoType/evoItem`. We build an `evolution.json` map, filling in levels where the canonical method isn't level/stone.

---

## 9. Party & storage

- Active party: up to **6**. Overflow caught mons go to a **PC box** accessible from the menu anywhere (no Poké Center needed).
- Party management (reorder, swap with box, view summary, use items, teach TMs) from an in-overworld menu.

---

## 10. Lobby, persistence & presence

### 10.1 Lobby lifecycle

- **Create**: choose **mode** (1-week | free); for 1-week, **day length** (default 24h); and **Poké Ball allowance per map** (10–100, or Infinite). Server mints a unique **6-digit code**.
- **Join**: enter code anytime — even mid-game; you spawn at map 1 (or your saved position if rejoining).
- **Leave**: via a menu button. Your save is retained (rejoin later with the same code + identity).
- A lobby has: mode, day config, **ball allowance**, current unlocked-map index, per-player saves, day counter + schedule, tournament state.

### 10.2 Persistence (survives refresh AND server restart)

- **File-based JSON** (zero deps): `saves/<code>.json` per lobby (gitignored). Debounced auto-save on state change + periodic flush. Loaded on server boot so a week-long game survives restarts.
- **Player identity**: on first join the server mints `{ playerId, secret }`; client stores it in `localStorage` keyed by lobby code. Refresh/reopen re-authenticates and resumes exactly where you were (map, position, party, money, badges, defeated trainers/gyms).

### 10.3 Multiplayer presence

- Players on the **same map** in the same lobby see each other's character walking (server broadcasts position/facing deltas; clients interpolate).
- **Click another player → invite to PvP.** On accept, both enter a server-run battle (reusing online battle code). Winner +₽1000, loser −₽1000 (balances can go negative).
- Presence is per-map: leaving a map removes you from others' view there.

---

## 11. 1-week mode specifics

- **Day scheduler** (server): each lobby tracks `dayIndex`, `dayStartedAt`, `dayLengthMs`. A timer fires at day end.
- **At day end**: unlock the next map (up to map 7, then the arena after the final day); apply **−₽2000** to every player who didn't battle that day; reset each player's `battledToday` flag.
- **Map unlock is dual-gated**: time-unlocked *and* both gyms beaten.
- **End of week**: after the final day, move everyone to map 8 and lock them there permanently; start tournament gathering.

(Free mode: all maps time-unlocked from the start, still badge-gated; no daily penalty; map 8 entered/left freely.)

---

## 12. Tournament (map 8)

- Triggered when (1-week) the week ends, or (free) players gather in the arena.
- **Gather gate**: waits for all lobby players to be online and present in the arena; **host may force-start** without everyone.
- **Bracket**: random single-elimination seeding. **Byes** handle odd counts (some players skip round 1).
- **One battle at a time**: only the two bracketed players fight; **all other players spectate** the live battle (server streams the same event feed to spectators).
- Winners advance until one **champion** remains.
- Battles reuse the server-authoritative engine; spectator view = read-only battle renderer.

---

## 13. Architecture

### 13.1 Current code (reused)

- `src/engine/*` — pure JS engine (dex, battle, damage, ai, pokemon, stats, rng, constants). **Reused unchanged** for all battle types.
- `src/ui/battle.js` (`BattleView`), `net.js` (`NetworkBattleView`), `movedesc.js`, `data.js`, `builder.js`, `styles.css`.
- `server/server.mjs` — static file server + WebSocket online battle (matchmaking, rooms, server-authoritative battle, spectatable event feed). **Extended**, not replaced.
- `index.html` → `src/ui/app.js` router.

### 13.2 New modules (proposed)

**Server (`server/`):**
- `lobby.js` — lobby registry, 6-digit codes, mode/day config, join/leave/auth.
- `world.js` — per-lobby world state: players, positions, defeated trainers/gyms, unlocked maps.
- `persist.js` — JSON load/save of `saves/<code>.json`, debounce, boot-load.
- `schedule.js` — 1-week day timer, unlocks, daily penalties.
- `tournament.js` — bracket generation, sequencing, spectator fan-out.
- `battles.js` — wrap existing battle room logic so wild(server-sim opponent)/trainer/gym/PvP/tournament all share it.

**Content data (`src/data/world/`):**
- `maps.json` — per-map tile grid + element coordinates.
- `encounters.json` — per-map weighted wild table.
- `trainers.json` — per-map 20 trainer parties + rewards.
- `gyms.json` — 14 leader parties + rewards.
- `mart.json` — per-map shop inventory + prices.
- `evolution.json` — evolution map (level/stone/assigned-levels; Eevee stone-only).
- `progression.json` — per-map level bands + caps + day defaults.
- (build) `scripts/download-sprites.mjs` extended to also fetch **shiny** front/back (#1–251); `data.js` gains a shiny-aware sprite lookup.

**Client (`src/ui/`):**
- `overworld.js` — tile renderer, grid movement, collision, interaction, other-player rendering.
- `lobby.js` (UI) — create/join screens, code entry, mode/day/ball-allowance pickers, starter + character picker.
- `menu.js` — party/box, bag, map, leave-lobby.
- `mart.js` — shop UI.
- `routeinfo.js` — per-map encounter list (species, % chance, level range).
- `presence.js` — position sync + PvP invite UI.
- `spectate.js` — read-only battle view for tournament.
- `world-data.js` — loader for the new JSON content.

### 13.3 WebSocket protocol (additive to existing battle messages)

Client → server: `createLobby`, `joinLobby{code}`, `auth{code,playerId,secret}`, `pickStarter`, `move{dir}`, `interact{target}`, `encounterAction`, `catch{ball}`, `startTrainerBattle{id}`, `startGymBattle{side}`, `buy{item,qty}`, `useItem`, `evolve`, `invitePvp{playerId}`, `acceptPvp`, `leaveLobby`, `tournamentReady`, `hostForceStart`.

Server → client: `lobbyCreated{code,playerId,secret}`, `joined{worldSnapshot}`, `state{delta}`, `presence{players}`, `encounter{wild}`, `battleStart{...}` + existing `events`/`request`/`end`, `caught{...}`, `reward{money}`, `mapUnlocked`, `dayEnded{penalties}`, `pvpInvite{from}`, `tournamentBracket`, `tournamentMatch`, `spectate{events}`, `champion{playerId}`, `error`.

All battles stay **server-authoritative** (clients send choices, animate returned events) — same model as the finished online battle.

---

## 14. Build plan (systems-first)

Tasks created in the task list (#11+). Ordering builds each system broadly, then layers content:

1. **#11 Content data layer** — author `maps/encounters/trainers/gyms/mart/evolution/progression` JSON for all 7 maps + arena; build-script support; validation. *(Big curation effort; the backbone everything else reads.)*
2. **#12 Overworld engine (client)** — tile renderer, grid movement, collision, interactions, camera. Single-player walking on real map data.
3. **#13 Wild encounters + catching** — encounter rolls, CATCH action, unlimited balls + Great Ball, catch formula, add to party/box.
4. **#14 Trainer & gym battles** — start from overworld, rewards, full-heal-after, badge tracking, north-exit gating, level-cap enforcement.
5. **#15 Mart / bag / evolution / party-box** — shop, items, level+stone evolution, party & PC management UI.
6. **#16 Lobby + persistence** — create/join by code, mode/day config, server world state, JSON persistence, reconnect/auth.
7. **#17 Multiplayer presence + PvP** — see others, position sync, click-to-invite, money transfer (negative allowed).
8. **#18 1-week mode** — day scheduler, daily unlock, mandatory-battle penalty, end-of-week lock to arena.
9. **#19 Tournament** — gather/force-start, random single-elim bracket with byes, one-at-a-time spectated battles, champion.
10. **#20 Overworld art polish** — import Gen-2 overworld character sprites, tile theming per map.

Each phase ends at a testable checkpoint (unit/integration scripts in `scripts/`, plus in-browser preview).

---

## 15. Open items to confirm (defaults assumed if unanswered)

Resolved (user-confirmed):
- ✅ **Dropped leaders**: Koga + Chuck (§5.1).
- ✅ **Level-cap behavior**: clamp effective level to the cap; no EXP gained above it (§5.2).
- ✅ **Economy**: start ₽0; trainer +₽200 flat; gym +₽1000; Great Ball ₽500; stat items ₽1000; Rare Candy ₽2000; stones ₽2000; TMs/HMs ₽2000 (§5.5–5.6).
- ✅ **Catch rate**: rarity-tier defaults; Great Ball ×5; shinies 1/300 with perfect IVs (§7).
- ✅ **Character sprites**: best-effort pixel-art overworld sprites — prefer HGSS/SoulSilver, FireRed acceptable.
- ✅ **Map fit**: single screen, no camera; single column of 10 trainers per side (§4).
- ✅ **Eevee**: stone-only; Espeon/Umbreon removed (§8).

Still open (sensible defaults assumed):
1. **Stat-item model** — true EV/stat-exp system vs simplified flat permanent boost per item (assumed: simplified flat boost, capped).
2. **Encounter rate %, exact grid dimensions, responsive tile size** — tunable proposals in §4.2 / §7.
3. **Map 8 free-mode tournament** — re-runnable, or once per lobby? (assumed: host starts when players gather; re-runnable in free mode.)
4. **Ball-allowance granularity** — is 10–100 a free integer, or fixed presets (e.g. 10/25/50/100/∞)? (assumed: presets.)
