// Dev helper: a headless online opponent. Connects to the running game server,
// joins the queue, auto-plays any battle with legal moves, then re-queues so a
// human in the browser can always find a match. Run alongside `npm run server`:
//   node scripts/bot.mjs            (defaults to ws://localhost:8080/ws)
//   node scripts/bot.mjs 8099       (custom port)
import { ensureDex } from '../server/server.mjs';

const port = process.argv[2] ? Number(process.argv[2]) : 8080;
const URL = `ws://localhost:${port}/ws`;
const dex = await ensureDex();

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

function joinQueue() {
  const ws = new WebSocket(URL);
  ws.addEventListener('open', () => {
    console.log('[bot] connected, queueing…');
    ws.send(JSON.stringify({ t: 'queue', name: 'TrainerBot', team: sampleTeam(3) }));
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'matched') console.log(`[bot] matched as side ${m.side} vs ${m.names[1 - m.side]}`);
    else if (m.t === 'request') ws.send(JSON.stringify({ t: 'choice', choice: pick(m.request) }));
    else if (m.t === 'end') { console.log(`[bot] battle ended (winner side ${m.end?.winner ?? m.winner}); re-queueing.`); ws.close(); }
    else if (m.t === 'oppLeft') { console.log('[bot] opponent left; re-queueing.'); ws.close(); }
  });
  ws.addEventListener('close', () => setTimeout(joinQueue, 500));
  ws.addEventListener('error', () => { console.log('[bot] connection error; retrying…'); });
}

joinQueue();
