// Headless verification of multiplayer presence + click-to-invite PvP (Task 17).
//
// Drives the real WebSocket protocol end-to-end with two clients sharing one
// lobby: presence fan-out (peers / peerJoin / peerMove / peerLeave across map
// changes), then a full invite → accept → server-authoritative battle → reward
// (winner +₽1000 / loser −₽1000) settled back to both saves.
import { flushAll } from '../server/persist.js';
import { ensureRegistry, start } from '../server/server.mjs';

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}`); } };

const PORT = 8098;
const reg = await ensureRegistry();
const server = await start(PORT);

// A client that records every message in order and lets the test await the next
// (unconsumed) message of a given type. During a battle it auto-answers every
// `request` with "use move 0" so the engine can run to completion.
function client() {
  const ws = new WebSocket(`ws://localhost:${PORT}/`);
  const api = { ws, log: [], cursor: 0, waiters: [], autoplay: false, send(o) { ws.send(JSON.stringify(o)); } };
  const deliver = () => {
    while (api.waiters.length && api.cursor < api.log.length) {
      const w = api.waiters[0];
      let idx = api.cursor;
      while (idx < api.log.length && !(w.type === '*' || api.log[idx].t === w.type)) idx++;
      if (idx >= api.log.length) break;
      const m = api.log[idx];
      api.cursor = idx + 1;
      api.waiters.shift();
      clearTimeout(w.to);
      w.resolve(m);
    }
  };
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    api.log.push(m);
    if (api.autoplay && m.t === 'request') api.send({ t: 'choice', choice: { type: 'move', move: 0 } });
    deliver();
  });
  api.deliver = deliver;
  return api;
}
function open(api) { return new Promise((res) => api.ws.addEventListener('open', res)); }
function waitFor(api, type, label, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const w = { type, resolve, to: setTimeout(() => { const i = api.waiters.indexOf(w); if (i >= 0) api.waiters.splice(i, 1); reject(new Error('timeout: ' + (label || type))); }, timeoutMs) };
    api.waiters.push(w);
    api.deliver();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let code, idA, idB;
try {
  // ---- two players in one lobby ------------------------------------------
  const a = client(); await open(a);
  a.send({ t: 'createLobby', mode: 'free', encounterAllowance: 25, name: 'Ash', starter: 'charmander', character: 'red' });
  const created = await waitFor(a, 'lobbyCreated', 'A create');
  code = created.code; idA = created.playerId;

  const b = client(); await open(b);
  b.send({ t: 'joinLobby', code, name: 'Misty', starter: 'squirtle', character: 'kris' });
  const joined = await waitFor(b, 'joined', 'B join');
  idB = joined.playerId;
  check('two distinct players in one lobby', idA && idB && idA !== idB);

  // ---- presence fan-out --------------------------------------------------
  // A announces position first (alone → empty peer list).
  a.send({ t: 'presence', map: 1, x: 1, y: 1, facing: 'down' });
  const aPeers0 = await waitFor(a, 'peers', 'A peers (alone)');
  check('A alone sees no peers', Array.isArray(aPeers0.list) && aPeers0.list.length === 0);

  // B announces → B should see A; A should get a peerJoin for B.
  b.send({ t: 'presence', map: 1, x: 5, y: 5, facing: 'up' });
  const bPeers0 = await waitFor(b, 'peers', 'B peers (sees A)');
  check('B sees A on the map', bPeers0.list.length === 1 && bPeers0.list[0].id === idA);
  check('peer carries name + character + tile', bPeers0.list[0].name === 'Ash' && bPeers0.list[0].character === 'red' && bPeers0.list[0].x === 1);
  const aRoster = await waitFor(a, 'peers', 'A learns of B (roster refresh)');
  check('A gets a roster including B (named Misty)', aRoster.list.some((p) => p.id === idB && p.name === 'Misty'));

  // A steps → B should see a peerMove.
  a.send({ t: 'presence', map: 1, x: 2, y: 1, facing: 'right' });
  const bMove = await waitFor(b, 'peerMove', 'B sees A move');
  check('B sees A move to new tile/facing', bMove.id === idA && bMove.x === 2 && bMove.facing === 'right');

  // A walks to map 2 → B should get peerLeave (A left B's map); A gets the new
  // map's (empty) peer list.
  a.send({ t: 'presence', map: 2, x: 0, y: 0, facing: 'up' });
  const bLeave = await waitFor(b, 'peerLeave', 'B sees A leave map 1');
  check('B sees A leave when A changes map', bLeave.id === idA);
  const aPeersMap2 = await waitFor(a, 'peers', 'A peers on map 2');
  check('A sees an empty map 2', aPeersMap2.map === 2 && aPeersMap2.list.length === 0);

  // A returns to map 1 → B sees A rejoin; A sees B again.
  a.send({ t: 'presence', map: 1, x: 1, y: 1, facing: 'down' });
  const bRejoin = await waitFor(b, 'peers', 'B sees A rejoin (roster refresh)');
  check('B sees A rejoin map 1', bRejoin.list.some((p) => p.id === idA));
  const aPeers1 = await waitFor(a, 'peers', 'A peers after return');
  check('A sees B after returning', aPeers1.list.length === 1 && aPeers1.list[0].id === idB);

  // ---- invite must respect same-map rule ---------------------------------
  // Move B to a different map and confirm an invite is rejected.
  b.send({ t: 'presence', map: 3, x: 0, y: 0, facing: 'up' });
  await waitFor(a, 'peerLeave', 'A sees B leave');
  a.send({ t: 'invitePvp', toPlayerId: idB });
  const offMap = await waitFor(a, 'error', 'off-map invite rejected');
  check('invite rejected when not on same map', offMap.code === 'OFF_MAP');
  // Bring B back to map 1 for the real battle.
  b.send({ t: 'presence', map: 1, x: 5, y: 5, facing: 'up' });
  await waitFor(a, 'peers', 'A sees B back (roster refresh)');
  await waitFor(b, 'peers', 'B peers back'); // drain B's own peers reply

  // ---- invite → accept → battle → reward ---------------------------------
  a.autoplay = true; b.autoplay = true;
  a.send({ t: 'invitePvp', toPlayerId: idB });
  const invite = await waitFor(b, 'pvpInvite', 'B receives invite');
  check('B receives a pvpInvite from Ash', invite.fromPlayerId === idA && invite.fromName === 'Ash');

  b.send({ t: 'acceptPvp', fromPlayerId: idA });
  const matchedA = await waitFor(a, 'matched', 'A matched');
  const matchedB = await waitFor(b, 'matched', 'B matched');
  check('both clients get matched with opposite sides', matchedA.side !== matchedB.side);

  const endA = await waitFor(a, 'end', 'battle ends (A)', 20000);
  await waitFor(b, 'end', 'battle ends (B)', 20000);
  check('battle resolves with a winner side', endA.winner === 0 || endA.winner === 1);

  const resA = await waitFor(a, 'pvpResult', 'A reward', 20000);
  const resB = await waitFor(b, 'pvpResult', 'B reward', 20000);
  const winner = [resA, resB].find((r) => r.result === 'win');
  const loser = [resA, resB].find((r) => r.result === 'lose');
  check('exactly one winner and one loser', !!winner && !!loser);
  check('winner gets +₽1000', winner && winner.delta === 1000 && winner.money === 1000);
  check('loser gets −₽1000 (may go negative)', loser && loser.delta === -1000 && loser.money === -1000);

  // The reward is authoritative + persisted server-side on both saves.
  await sleep(50);
  const lobby = reg.get(code);
  const moneys = [lobby.players[idA].save.money, lobby.players[idB].save.money].sort((x, y) => x - y);
  check('server saves reflect the wager (−1000 / +1000)', moneys[0] === -1000 && moneys[1] === 1000);
  check('both flagged battledToday', lobby.players[idA].save.battledToday === true && lobby.players[idB].save.battledToday === true);

  a.ws.close(); b.ws.close();
} catch (err) {
  fail++; console.error('FAIL  presence/pvp flow:', err && err.stack || err);
}

if (code) await reg.removeLobby(code);
await flushAll();
server.close();

console.log(`\npresence + PvP: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
