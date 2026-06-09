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

// Create a free-mode lobby with a known starter.
const { lobby, identity } = reg.createLobby({ mode: 'free', ballAllowance: 25, name: 'Ash', starter: 'charmander', character: 'red' });
const code = lobby.code;
check('code is 6 digits', /^\d{6}$/.test(code));
check('identity has playerId + secret', !!identity.playerId && !!identity.secret);
check('starter is charmander Lv5', identity.save.party[0].species === 'charmander' && identity.save.party[0].level === 5);
check('starter has moves', Array.isArray(identity.save.party[0].moves) && identity.save.party[0].moves.length > 0);
check('starts with ₽0', identity.save.money === 0);
check('balls allowance applied (25)', identity.save.balls.pokeball === 25);
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
const join = reg.joinLobby(code, { name: 'Misty', starter: 'squirtle', character: 'kris' });
check('join mints a distinct playerId', join && join.identity.playerId !== identity.playerId);
check('joiner gets a fresh ₽0 save', join && join.identity.save.money === 0);
check('joiner starter squirtle', join && join.identity.save.party[0].species === 'squirtle');
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
check('restored config preserved (ballAllowance)', restored && restored.ballAllowance === 25);

// Infinite allowance + week mode.
const inf = reg.createLobby({ mode: 'week', dayLength: '1min', ballAllowance: 'infinite', name: 'Gold', starter: 'cyndaquil' });
check('infinite allowance stored as sentinel', inf.identity.save.balls.pokeball === 'infinite');
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
  c1.send({ t: 'createLobby', mode: 'free', ballAllowance: 50, name: 'Net', starter: 'totodile', character: 'silver' });
  const created = await once(c1, 'lobbyCreated');
  wsCode = created.code; wsId = created.playerId; wsSecret = created.secret;
  check('WS lobbyCreated returns code/identity', /^\d{6}$/.test(wsCode) && !!wsId && !!wsSecret);
  check('WS save has totodile + 50 balls', created.save.party[0].species === 'totodile' && created.save.balls.pokeball === 50);

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
