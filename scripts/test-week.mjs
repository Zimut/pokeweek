// Headless verification of 1-week mode (Task 18): the day scheduler, per-day
// route unlocks, the daily "didn't battle" penalty, and the end-of-week lock.
//
// Two clients share one week-mode lobby. We drive the schedule deterministically
// by injecting `now` into reg.tickAll(...) (rather than waiting real time) and
// assert the server's authoritative state + the `dayAdvanced` pushes both
// clients receive: a fresh route opening, the −₽2000 fine for the idler, the
// catch-up of many missed days at once, and the lock that closes PvP.
import { flushAll } from '../server/persist.js';
import { ensureRegistry, start } from '../server/server.mjs';

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}`); } };

const PORT = 8099;
const reg = await ensureRegistry();
const server = await start(PORT);

// Minimal client: records messages and lets the test await the next (unconsumed)
// message of a given type via a cursor (same pattern as test-presence.mjs).
function client() {
  const ws = new WebSocket(`ws://localhost:${PORT}/`);
  const api = { ws, log: [], cursor: 0, waiters: [], send(o) { ws.send(JSON.stringify(o)); } };
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
  ws.addEventListener('message', (ev) => { api.log.push(JSON.parse(ev.data)); deliver(); });
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
  // ---- a fresh week-mode lobby -------------------------------------------
  // A 1-hour day means the real 1s scheduler never fires during the test; we
  // advance time ourselves by injecting `now` into reg.tickAll(...).
  const a = client(); await open(a);
  a.send({ t: 'createLobby', mode: 'week', dayLengthMs: 3600000, name: 'Ash', starter: 'charmander', character: 'red' });
  const created = await waitFor(a, 'lobbyCreated', 'A create');
  code = created.code; idA = created.playerId;
  check('week lobby opens on day 0, route 1, unlocked', created.config.mode === 'week' && created.config.unlockedMap === 1 && created.config.dayIndex === 0 && created.config.locked === false);
  check('a week is 7 days long', created.config.weekLength === 7);

  const b = client(); await open(b);
  b.send({ t: 'joinLobby', code, name: 'Misty', starter: 'squirtle', character: 'kris' });
  const joined = await waitFor(b, 'joined', 'B join');
  idB = joined.playerId;
  check('joiner sees the same week config', joined.config.mode === 'week' && joined.config.unlockedMap === 1);

  const lobby = reg.get(code);
  const t0 = lobby.dayStartedAt;
  const D = lobby.dayLengthMs;

  // ---- day 1 boundary: A battled, B idled --------------------------------
  lobby.players[idA].save.battledToday = true;
  lobby.players[idB].save.battledToday = false;
  reg.tickAll(t0 + D + 10);

  const dayA = await waitFor(a, 'dayAdvanced', 'A day 1');
  const dayB = await waitFor(b, 'dayAdvanced', 'B day 1');
  check('day advances to index 1 and opens route 2', dayA.config.dayIndex === 1 && dayA.config.unlockedMap === 2 && dayA.locked === false);
  check('both clients are told the day advanced', dayA.daysAdvanced === 1 && dayB.daysAdvanced === 1);
  check('the battler escapes the fine', dayA.penalty === null);
  check('the idler is fined ₽2000', dayB.penalty && dayB.penalty.delta === -2000 && dayB.penalty.money === -2000);
  check('server resets battle flags for the new day', lobby.players[idA].save.battledToday === false && lobby.players[idB].save.battledToday === false);
  check('server money reflects the fine (A 0 / B −2000)', lobby.players[idA].save.money === 0 && lobby.players[idB].save.money === -2000);

  // ---- catch up many missed days at once → end-of-week lock --------------
  // Jump far past the end of the week: every remaining day is settled in one
  // tick (nobody battled, so both are fined each day) and the lobby locks.
  reg.tickAll(t0 + D * 20);
  const lockA = await waitFor(a, 'dayAdvanced', 'A lock');
  await waitFor(b, 'dayAdvanced', 'B lock');
  check('the week locks after the final route', lockA.locked === true && lobby.locked === true);
  check('all 7 routes are open at lock (day 7)', lockA.config.unlockedMap === 7 && lockA.config.dayIndex === 7);
  check('catch-up settled the 6 remaining days', lockA.daysAdvanced === 6 && lockA.penalty.delta === -12000);
  check('final balances stack every missed fine', lobby.players[idA].save.money === -12000 && lobby.players[idB].save.money === -14000);

  // A locked lobby ignores further ticks (no double-penalty / past-the-end days).
  const idxBefore = lobby.dayIndex;
  reg.tickAll(t0 + D * 100);
  check('locked lobby ignores further ticks', lobby.dayIndex === idxBefore);

  // ---- PvP is closed once the week is over -------------------------------
  a.send({ t: 'invitePvp', toPlayerId: idB });
  const err = await waitFor(a, 'error', 'locked invite');
  check('battles are refused after the week ends', err.code === 'WEEK_OVER');

  // The lock survives a reload from disk (persisted), so it can't be reset.
  await reg.persistNow(code);
  const reloaded = reg.get(code).serialize();
  check('lock + schedule persist to disk', reloaded.locked === true && reloaded.dayIndex === 7 && reloaded.unlockedMap === 7);

  a.ws.close(); b.ws.close();
} catch (err) {
  fail++; console.error('FAIL  week-mode flow:', err && err.stack || err);
}

if (code) await reg.removeLobby(code);
reg.stopScheduler();
await flushAll();
server.close();

console.log(`\n1-week mode: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
