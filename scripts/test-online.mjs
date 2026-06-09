// Headless verification of the authoritative online battle protocol.
// Spins up a GameRoom with two simulated clients (no real sockets) that behave
// exactly like the browser would: they consume `events`, answer each `request`
// with a legal choice, and stop on `end`/`oppLeft`. This exercises the full
// server-side turn loop and the shared engine end-to-end.
import { GameRoom, ensureDex } from '../server/server.mjs';

const dex = await ensureDex();

// A fake connection that mimics the WSConn surface the GameRoom touches.
class FakeConn {
  constructor(name, team, picker) {
    this._name = name;
    this._team = team;
    this._room = null;
    this.alive = true;
    this.picker = picker;
    this.log = { events: 0, requests: 0, waits: 0, matched: null, end: null, oppLeft: false, errors: [] };
  }
  send(msg) {
    switch (msg.t) {
      case 'matched': this.log.matched = msg; break;
      case 'events': this.log.events += msg.events.length; this.lastTeams = msg.teams; break;
      case 'waitOpp': this.log.waits++; break;
      case 'request': {
        this.log.requests++;
        const choice = this.picker(msg.request, this);
        // Reply on a future tick, like a network round-trip.
        setImmediate(() => { if (this._room) this._room.onChoice(this, choice); });
        break;
      }
      case 'end': this.log.end = msg; break;
      case 'oppLeft': this.log.oppLeft = true; break;
      case 'error': this.log.errors.push(msg.msg || 'error'); break;
      default: break;
    }
  }
  close() { this.alive = false; if (this._room) this._room.onLeave(this); }
}

function sampleTeam(n) {
  const all = dex.allSpecies();
  const picks = [];
  const used = new Set();
  while (picks.length < n) {
    const sp = all[Math.floor(Math.random() * all.length)];
    if (used.has(sp.id)) continue;
    used.add(sp.id);
    const level = 50;
    picks.push({ species: sp.id, level, moves: dex.defaultMoves(sp.id, level) });
  }
  return picks;
}

// A simple but legal player: first usable move, else first available switch.
function pick(request) {
  if (request.state === 'switch') {
    const target = request.team.find((p) => !p.active && !p.fainted);
    return { type: 'switch', target: target ? target.index : 0 };
  }
  if (request.forceMove) return { type: 'move', forced: request.forceMove };
  const usable = request.active.moves.find((m) => !m.disabled);
  return { type: 'move', move: usable ? usable.index : 0 };
}

function runOne(seedLabel) {
  return new Promise((resolve, reject) => {
    const a = new FakeConn('Alice', sampleTeam(3), pick);
    const b = new FakeConn('Bob', sampleTeam(3), pick);
    const room = new GameRoom(a, b, dex);
    const started = Date.now();
    const timer = setInterval(() => {
      if (a.log.end && b.log.end) {
        clearInterval(timer);
        resolve({ a, b, room });
      } else if (Date.now() - started > 8000) {
        clearInterval(timer);
        const b = room.battle;
        const diag = {
          state: b.state, turn: b.turn, ended: b.ended, over: room.over,
          needSwitch: b.needSwitch,
          needAction: [b.needAction(0), b.needAction(1)],
          waiter: room.players.map((p) => !!p.waiter),
          queueLen: room.players.map((p) => p.queue.length),
          aEnd: !!a.log.end, bEnd: !!b.log?.end,
          active: [b.sides[0].active.name + ' hp' + b.sides[0].active.hp, b.sides[1].active.name + ' hp' + b.sides[1].active.hp],
          alive: [b.sides[0].aliveCount(), b.sides[1].aliveCount()],
        };
        reject(new Error(`${seedLabel}: not finished. ` + JSON.stringify(diag)));
      }
    }, 5);
  });
}

let pass = 0, fail = 0;
const N = process.env.N ? Number(process.env.N) : 40;
for (let i = 0; i < N; i++) {
  try {
    const { a, b, room } = await runOne(`battle ${i + 1}`);
    const w = room.battle.winner;
    const okSide = a.log.matched.side === 0 && b.log.matched.side === 1;
    const sameWinner = a.log.end.winner === b.log.end.winner && a.log.end.winner === w;
    const noErrors = a.log.errors.length === 0 && b.log.errors.length === 0;
    const sawEvents = a.log.events > 0 && b.log.events > 0;
    if (okSide && sameWinner && noErrors && sawEvents && (w === 0 || w === 1 || w === 'tie')) {
      pass++;
      if (i < 3) {
        console.log(`battle ${i + 1}: winner=${w === 'tie' ? 'tie' : (w === 0 ? 'Alice' : 'Bob')} ` +
          `turns=${room.battle.turn} events(A/B)=${a.log.events}/${b.log.events} requests(A/B)=${a.log.requests}/${b.log.requests}`);
      }
    } else {
      fail++;
      console.error(`battle ${i + 1} FAILED:`, { okSide, sameWinner, noErrors, sawEvents, w, errA: a.log.errors, errB: b.log.errors });
    }
  } catch (err) {
    fail++;
    console.error(err.message);
  }
}

// Disconnect handling: the surviving player should be told the opponent left.
const discResult = await new Promise((resolve) => {
  const a = new FakeConn('Alice', sampleTeam(3), pick);
  const b = new FakeConn('Bob', sampleTeam(3), (req, self) => {
    // Bob bails the first time he is asked to move.
    setImmediate(() => self.close());
    return { type: 'move', move: 0 };
  });
  const room = new GameRoom(a, b, dex);
  setTimeout(() => resolve({ a, b, room }), 500);
});
const discOk = discResult.a.log.oppLeft === true && discResult.room.over === true;
console.log(`\ndisconnect test: opponent notified=${discResult.a.log.oppLeft} room closed=${discResult.room.over} -> ${discOk ? 'PASS' : 'FAIL'}`);
if (!discOk) fail++;

console.log(`\nonline protocol: ${pass}/${N} battles passed, ${fail} failures total.`);
process.exit(fail ? 1 : 0);
