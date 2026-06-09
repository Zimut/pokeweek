// End-to-end test of the real WebSocket transport: boots the actual server,
// connects two genuine WebSocket clients over TCP, and plays a full battle.
// This validates the hand-rolled RFC 6455 handshake + frame codec against a
// real client (Node's global WebSocket), beyond the in-process GameRoom test.
import { start, ensureDex } from '../server/server.mjs';

const PORT = 8099;

const dex = await ensureDex();
const server = await start(PORT);

function sampleTeam(n) {
  const all = dex.allSpecies();
  const picks = []; const used = new Set();
  while (picks.length < n) {
    const sp = all[Math.floor(Math.random() * all.length)];
    if (used.has(sp.id)) continue;
    used.add(sp.id);
    picks.push({ species: sp.id, level: 50, moves: dex.defaultMoves(sp.id, 50) });
  }
  return picks;
}

function pick(request) {
  if (request.state === 'switch') {
    const t = request.team.find((p) => !p.active && !p.fainted);
    return { type: 'switch', target: t ? t.index : 0 };
  }
  if (request.forceMove) return { type: 'move', forced: request.forceMove };
  const m = request.active.moves.find((x) => !x.disabled);
  return { type: 'move', move: m ? m.index : 0 };
}

function makeClient(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const state = { name, side: null, events: 0, requests: 0, end: null, errors: [] };
    const fail = setTimeout(() => reject(new Error(`${name}: timed out`)), 15000);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'queue', name, team: sampleTeam(3) })));
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'matched') state.side = m.side;
      else if (m.t === 'events') state.events += m.events.length;
      else if (m.t === 'request') { state.requests++; ws.send(JSON.stringify({ t: 'choice', choice: pick(m.request) })); }
      else if (m.t === 'error') state.errors.push(m.msg || 'error');
      else if (m.t === 'end') { state.end = m; clearTimeout(fail); ws.close(); resolve(state); }
    });
    ws.addEventListener('error', () => { clearTimeout(fail); reject(new Error(`${name}: socket error`)); });
  });
}

try {
  const [a, b] = await Promise.all([makeClient('Alice'), makeClient('Bob')]);
  const sidesOk = (a.side === 0 || a.side === 1) && a.side !== b.side;
  const ok = sidesOk
    && a.end && b.end && a.end.winner === b.end.winner
    && a.events > 0 && b.events > 0
    && a.errors.length === 0 && b.errors.length === 0;
  const w = a.end.winner;
  console.log(`matched sides: Alice=${a.side} Bob=${b.side}`);
  console.log(`events received: Alice=${a.events} Bob=${b.events}; requests: Alice=${a.requests} Bob=${b.requests}`);
  console.log(`winner=${w === 'tie' ? 'tie' : (w === 0 ? 'Alice' : 'Bob')} after ${a.end.turns} turns`);
  console.log(`\nWebSocket transport: ${ok ? 'PASS' : 'FAIL'}`);
  server.close();
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error('FAIL:', err.message);
  server.close();
  process.exit(1);
}
