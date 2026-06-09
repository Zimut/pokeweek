// Headless verification of the lobby + persistence + reconnection system.
//
// Part A exercises the registry/persistence modules in-process: create / join /
// auth / saveState, the on-disk JSON file, and a simulated SERVER RESTART (a
// brand-new registry that boot-loads the same saves from disk).
//
// Part B drives the real WebSocket protocol end-to-end: a genuine client mints
// a lobby, reports a save, disconnects, reconnects, and resumes via auth.
import { ensureWorld, LobbyRegistry } from '../server/world.js';
import { flushAll } from '../server/persist.js';
import { ensureDex, ensureRegistry, start } from '../server/server.mjs';

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}`); } };

// ---------------------------------------------------------------------------
//  Part A — registry + persistence, in-process
// ---------------------------------------------------------------------------
console.log('Part A: registry + persistence');
const dex = await ensureDex();
const world = await ensureWorld();
const reg = new LobbyRegistry(world, dex);
// New players are gifted a random Lv5 mon from the Route 1 + Route 2 pools.
const giftPool = new Set([...(world.encounters[1] || []), ...(world.encounters[2] || [])].map((e) => e.species));

// Create a free-mode lobby (players are gifted a random Route 1/2 Pokémon).
const { lobby, identity } = reg.createLobby({ mode: 'free', encounterAllowance: 25, name: 'Ash', character: 'red' });
const code = lobby.code;
check('code is 6 digits', /^\d{6}$/.test(code));
check('identity has playerId + secret', !!identity.playerId && !!identity.secret);
check('gift is a Lv5 Route 1/2 mon', identity.save.party[0].level === 5 && giftPool.has(identity.save.party[0].species));
check('gift has 15 IVs across the board', Object.values(identity.save.party[0].ivs).every((v) => v === 15));
check('gift has moves', Array.isArray(identity.save.party[0].moves) && identity.save.party[0].moves.length > 0);
check('starts with ₽0', identity.save.money === 0);
check('encounter allowance applied (25)', identity.save.encounters[1] === 25);
check('spawns on map 1', identity.save.map === 1);
check('free mode unlocks all maps', lobby.unlockedMap === world.progression.mapCount);

// Mutate + persist a save.
const updated = { ...identity.save, money: 1234, x: 9, y: 4, badges: { 1: { kanto: true } } };
updated.party = updated.party.concat([{ species: 'pidgey', level: 7, shiny: false, moves: dex.defaultMoves('pidgey', 7) }]);
check('saveState accepted', reg.saveState(code, identity.playerId, updated) === true);

// Resume with the right identity; reject the wrong secret.
const good = reg.auth(code, identity.playerId, identity.secret);
check('auth restores updated money', good && good.player.save.money === 1234);
check('auth restores added party member', good && good.player.save.party.length === 2);
check('auth rejects wrong secret', reg.auth(code, identity.playerId, 'nope') === null);
check('auth rejects unknown lobby', reg.auth('000000', identity.playerId, identity.secret) === null);

// A second player joins the same lobby with their own identity + fresh save.
const join = reg.joinLobby(code, { name: 'Misty', character: 'kris' });
check('join mints a distinct playerId', join && join.identity.playerId !== identity.playerId);
check('joiner gets a fresh ₽0 save', join && join.identity.save.money === 0);
check('joiner gets a Route 1/2 gift', join && giftPool.has(join.identity.save.party[0].species));
check('lobby now has 2 players', Object.keys(lobby.players).length === 2);

// Force the save to disk and simulate a SERVER RESTART by booting a new registry.
await reg.persistNow(code);
const reg2 = new LobbyRegistry(world, dex);
await reg2.loadFromDisk();
const restored = reg2.get(code);
check('lobby survives restart', !!restored);
check('restored lobby keeps both players', restored && Object.keys(restored.players).length === 2);
const resumed = reg2.auth(code, identity.playerId, identity.secret);
check('restored save keeps money after restart', resumed && resumed.player.save.money === 1234);
check('restored config preserved (encounterAllowance)', restored && restored.encounterAllowance === 25);

// Infinite allowance + week mode.
const inf = reg.createLobby({ mode: 'week', dayLength: '1min', encounterAllowance: 'infinite', name: 'Gold', starter: 'cyndaquil' });
check('infinite allowance: unlimited encounters', inf.lobby.encounterAllowance === 'infinite' && Object.keys(inf.identity.save.encounters || {}).length === 0);
check('week mode unlocks only map 1', inf.lobby.unlockedMap === 1);
check('week day length preset applied (1min)', inf.lobby.dayLengthMs === 60000);

// sanitizeSave guards against an empty party.
const beforeParty = good.player.save.party;
reg.saveState(code, identity.playerId, { ...good.player.save, party: [] });
check('rejects empty party (keeps previous)', reg.get(code).players[identity.playerId].save.party === beforeParty || reg.get(code).players[identity.playerId].save.party.length >= 1);

// Cleanup the test lobbies from disk.
await reg.removeLobby(code);
await reg.removeLobby(inf.lobby.code);
await reg2.removeLobby(code);

// ---------------------------------------------------------------------------
//  Part B — real WebSocket protocol: create → save → reconnect → resume
// ---------------------------------------------------------------------------
console.log('\nPart B: WebSocket create / save / resume');
const PORT = 8097;
await ensureRegistry();
const server = await start(PORT);

function client() {
  const ws = new WebSocket(`ws://localhost:${PORT}/`);
  const api = { ws, handlers: {}, on(t, fn) { this.handlers[t] = fn; }, send(o) { ws.send(JSON.stringify(o)); } };
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); (api.handlers[m.t] || (() => {}))(m); });
  return api;
}
function once(api, t, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), timeoutMs);
    api.on(t, (m) => { clearTimeout(to); resolve(m); });
  });
}
const open = (api) => new Promise((res) => api.ws.addEventListener('open', res));

let wsCode, wsId, wsSecret;
try {
  const c1 = client();
  await open(c1);
  c1.send({ t: 'createLobby', mode: 'free', encounterAllowance: 50, name: 'Net', character: 'silver' });
  const created = await once(c1, 'lobbyCreated');
  wsCode = created.code; wsId = created.playerId; wsSecret = created.secret;
  check('WS lobbyCreated returns code/identity', /^\d{6}$/.test(wsCode) && !!wsId && !!wsSecret);
  check('WS save has a Route 1/2 gift + 50 encounters', giftPool.has(created.save.party[0].species) && created.save.encounters[1] === 50);

  // Report a save, then disconnect.
  c1.send({ t: 'saveState', ack: true, save: { ...created.save, money: 5000, map: 2, x: 3, y: 3 } });
  await once(c1, 'saved');
  c1.ws.close();

  // Reconnect with stored identity and resume.
  const c2 = client();
  await open(c2);
  c2.send({ t: 'auth', code: wsCode, playerId: wsId, secret: wsSecret });
  const resumedMsg = await once(c2, 'resumed');
  check('WS auth resumes saved money', resumedMsg.save.money === 5000);
  check('WS auth resumes saved map/pos', resumedMsg.save.map === 2 && resumedMsg.save.x === 3);

  // Bad auth path.
  const c3 = client();
  await open(c3);
  c3.send({ t: 'auth', code: wsCode, playerId: wsId, secret: 'bogus' });
  const errMsg = await once(c3, 'error');
  check('WS bad secret -> error', errMsg.code === 'AUTH_FAILED');
  c2.ws.close(); c3.ws.close();
} catch (err) {
  fail++; console.error('FAIL  Part B:', err.message);
}

// Clean up the WS lobby's save file, flush, and shut down.
if (wsCode) { const r = await ensureRegistry(); await r.removeLobby(wsCode); }
await flushAll();
server.close();

console.log(`\nlobby system: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
