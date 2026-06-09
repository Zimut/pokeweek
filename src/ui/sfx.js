// Tiny procedural sound effects via the Web Audio API — no asset files, so it
// stays within the project's zero-dependency rule. Everything is synthesised
// from oscillators + decaying noise. A mute preference persists in localStorage.
const KEY = 'pokeweek:muted';

let ctx = null;
let muted = (() => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } })();

function ac() {
  if (!ctx) {
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch { ctx = null; }
  }
  // Browsers start the context suspended until a user gesture; resume lazily.
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// A single enveloped oscillator note (optionally pitch-sliding).
function tone({ freq = 440, dur = 0.12, type = 'square', gain = 0.14, slideTo = null, delay = 0 }) {
  const c = ac(); if (!c) return;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t0); osc.stop(t0 + dur + 0.03);
}

// A short burst of decaying white noise (impacts).
function noise({ dur = 0.14, gain = 0.18, delay = 0 }) {
  const c = ac(); if (!c) return;
  const t0 = c.currentTime + delay;
  const n = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, n, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = c.createBufferSource(); src.buffer = buf;
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(g).connect(c.destination);
  src.start(t0); src.stop(t0 + dur + 0.02);
}

const seq = (notes, type = 'triangle', gain = 0.12, step = 0.09) =>
  notes.forEach((f, i) => tone({ freq: f, dur: step * 0.9, type, gain, delay: i * step }));

const SOUNDS = {
  menu: () => tone({ freq: 620, dur: 0.045, type: 'square', gain: 0.07 }),
  select: () => tone({ freq: 880, dur: 0.07, type: 'square', gain: 0.1 }),
  back: () => tone({ freq: 320, dur: 0.06, type: 'square', gain: 0.08 }),
  hit: () => noise({ dur: 0.11, gain: 0.16 }),
  superhit: () => { noise({ dur: 0.18, gain: 0.24 }); tone({ freq: 220, slideTo: 70, dur: 0.2, type: 'sawtooth', gain: 0.12 }); },
  weakhit: () => noise({ dur: 0.08, gain: 0.08 }),
  faint: () => tone({ freq: 420, slideTo: 55, dur: 0.55, type: 'sine', gain: 0.18 }),
  lowhp: () => { tone({ freq: 880, dur: 0.09, type: 'square', gain: 0.07 }); tone({ freq: 880, dur: 0.09, type: 'square', gain: 0.07, delay: 0.14 }); },
  stat: () => tone({ freq: 440, slideTo: 920, dur: 0.16, type: 'square', gain: 0.1 }),
  statdown: () => tone({ freq: 440, slideTo: 200, dur: 0.16, type: 'square', gain: 0.1 }),
  throw: () => tone({ freq: 300, slideTo: 620, dur: 0.16, type: 'square', gain: 0.1 }),
  wobble: () => tone({ freq: 520, dur: 0.05, type: 'triangle', gain: 0.1 }),
  catch: () => seq([523, 659, 784, 1047], 'square', 0.12, 0.1),
  levelup: () => seq([523, 659, 784], 'triangle', 0.12, 0.08),
  evolve: () => seq([392, 523, 659, 784, 1047], 'triangle', 0.12, 0.11),
  bump: () => tone({ freq: 130, dur: 0.08, type: 'square', gain: 0.12 }),
  win: () => seq([523, 659, 784, 1047], 'square', 0.13, 0.12),
};

export const sfx = {
  play(name) { if (muted) return; const f = SOUNDS[name]; if (f) { try { f(); } catch { /* audio unavailable */ } } },
  isMuted() { return muted; },
  toggle() {
    muted = !muted;
    try { localStorage.setItem(KEY, muted ? '1' : '0'); } catch { /* ignore */ }
    if (!muted) this.play('menu'); // a blip confirms unmute (also primes the context)
    return muted;
  },
};
