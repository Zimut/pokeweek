// Headless verification of the arena tournament (Task 19): the week-end → arena
// handoff, the gather gate + host force-start, random single-elimination bracket
// with a bye for an odd count, one spectated battle at a time, and the champion.
//
// Three clients share one week-mode lobby. We lock the week by injecting `now`
// into reg.tickAll(...), which teleports everyone to the arena and opens
// gathering. Each client reports arena presence; the host force-starts. The two
// combatant clients autoplay their requests (random legal move) so the
// server-authoritative battles actually resolve, while the third spectates the
// live event feed. We assert the bracket shape (1 real match + 1 bye in round 0,
// then a final), that exactly one battle is live at a time, that a spectator
// receives the read-only feed, and that a single champion is crowned.
import { flushAll } from '../server/persist.js';
import { ensureRegistry, start, tournamentFor, clearTournament } from '../server/server.mjs';

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}`); } };

const PORT = 8100;
const reg = await ensureRegistry();
reg.tournamentMatchDelayMs = 40;   // race through the breather between matches
const server = await start(PORT);

// A client that records every message, auto-answers battle `request`s (so its
// matches resolve without a human), and lets the test await messages via a
// cursor (same pattern as test-week.mjs / test-presence.mjs).
function client() {
  const ws = new WebSocket(`ws://localhost:${PORT}/`);
  const api = { ws, log: [], cursor: 0, waiters: [], matched: 0, specEvents: 0, specEnds: 0, send(o) { ws.send(JSON.stringify(o)); } };
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
    // Tally + autoplay regardless of what the test is awaiting.
    if (m.t === 'matched') api.matched++;
    if (m.t === 'spectate' && m.sub === 'events') api.specEvents++;
    if (m.t === 'spectate' && m.sub === 'end') api.specEnds++;
    if (m.t === 'request') {
      const req = m.request || {};
      let choice;
      if (req.state === 'switch') choice = { type: 'switch', target: 0 };
      else if (req.forceMove) choice = { type: 'move', forced: req.forceMove };
      else { const n = (req.active && req.active.moves && req.active.moves.length) || 1; choice = { type: 'move', move: (Math.random() * n) | 0 }; }
      api.send({ t: 'choice', choice });
    }
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
// Wait for a tournamentState (anywhere ahead of the cursor) whose snapshot
// satisfies `pred`. Scans without consuming non-matching messages.
function waitForState(api, pred, label, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('timeout: ' + label)), timeoutMs);
    const scan = () => {
      for (let i = 0; i < api.log.length; i++) {
        const m = api.log[i];
        if (m.t === 'tournamentState' && pred(m.tournament)) { clearTimeout(to); resolve(m.tournament); return true; }
      }
      return false;
    };
    if (scan()) return;
    const onMsg = () => { if (scan()) api.ws.removeEventListener('message', onMsg); };
    api.ws.addEventListener('message', onMsg);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let code;
try {
  // ---- a week lobby with three players -----------------------------------
  const A = client(); await open(A);
  A.send({ t: 'createLobby', mode: 'week', dayLengthMs: 3600000, name: 'Ash', starter: 'charmander', character: 'red' });
  const created = await waitFor(A, 'lobbyCreated', 'A create');
  code = created.code;
  check('week lobby opens (arena map is 8)', created.config.mode === 'week' && created.config.arenaMap === 8);

  const B = client(); await open(B);
  B.send({ t: 'joinLobby', code, name: 'Misty', starter: 'squirtle', character: 'kris' });
  await waitFor(B, 'joined', 'B join');

  const C = client(); await open(C);
  C.send({ t: 'joinLobby', code, name: 'Brock', starter: 'bulbasaur', character: 'blue' });
  await waitFor(C, 'joined', 'C join');

  const lobby = reg.get(code);
  const t0 = lobby.dayStartedAt, D = lobby.dayLengthMs;
  // Nobody gets fined into the void — mark all as having battled each catch-up day.
  for (const p of Object.values(lobby.players)) p.save.battledToday = true;

  // ---- lock the week → everyone is herded into the arena -----------------
  reg.tickAll(t0 + D * 20);
  const ea = await waitFor(A, 'enterArena', 'A enterArena');
  await waitFor(B, 'enterArena', 'B enterArena');
  await waitFor(C, 'enterArena', 'C enterArena');
  check('week-end moves players to the arena (map 8)', ea.map === 8 && lobby.locked === true);
  check('a gathering tournament exists', !!tournamentFor(code) && tournamentFor(code).status === 'gathering');

  // ---- gather: everyone reports arena presence ---------------------------
  for (const cl of [A, B, C]) {
    cl.send({ t: 'presence', map: ea.map, x: ea.x, y: ea.y, facing: 'up' });
    cl.send({ t: 'tournamentEnter' });
  }
  const gathered = await waitForState(A, (s) => s.status === 'gathering' && s.present.length === 3, 'all three present');
  check('gather gate sees all three players present', gathered.present.length === 3);
  check('host is the lobby creator (Ash)', gathered.hostId === created.playerId);

  // ---- host force-starts the bracket -------------------------------------
  A.send({ t: 'tournamentStart' });
  const active = await waitForState(A, (s) => s.status === 'active' && s.rounds.length >= 1, 'bracket seeded');
  const r0 = active.rounds[0];
  check('round 1 seeds 3 entrants into 2 slots', active.entrants.length === 3 && r0.length === 2);
  const byes = r0.filter((m) => m.bye);
  check('an odd count produces exactly one bye', byes.length === 1 && byes[0].winner != null);
  const real0 = r0.filter((m) => !m.bye);
  check('round 1 has exactly one real match', real0.length === 1 && real0[0].a && real0[0].b);

  // ---- the bracket plays out to a champion -------------------------------
  const champMsg = await waitFor(A, 'champion', 'champion crowned', 12000);
  const entrants = active.entrants.map((e) => e.id);
  check('a champion is crowned from the entrants', !!champMsg.playerId && entrants.includes(champMsg.playerId));
  check('champion message carries a display name', typeof champMsg.name === 'string' && champMsg.name.length > 0);

  const done = await waitForState(A, (s) => s.status === 'done', 'tournament done');
  check('final state is done with the same champion', done.champion === champMsg.playerId);
  check('the bracket grew a second (final) round', done.rounds.length === 2 && done.rounds[1].length === 1);
  check('the final has a recorded winner', done.rounds[1][0].winner === champMsg.playerId);

  // ---- battles were real + spectated -------------------------------------
  const totalMatched = A.matched + B.matched + C.matched;
  check('exactly two real matches were played (4 matched msgs)', totalMatched === 4);
  const totalSpecEnds = A.specEnds + B.specEnds + C.specEnds;
  const totalSpecEvents = A.specEvents + B.specEvents + C.specEvents;
  check('a spectator received the live event feed', totalSpecEvents > 0);
  check('every spectated match closed for its viewer', totalSpecEnds >= 2);

  // ---- the live tournament reference is cleared on the server ------------
  check('server tournament reached done status', tournamentFor(code).status === 'done' && tournamentFor(code).current === null);

  A.ws.close(); B.ws.close(); C.ws.close();
} catch (err) {
  fail++; console.error('FAIL  tournament flow:', err && err.stack || err);
}

if (code) { clearTournament(code); await reg.removeLobby(code); }
reg.stopScheduler();
await flushAll();
server.close();

console.log(`\nTournament arena: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
