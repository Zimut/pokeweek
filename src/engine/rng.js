// Seedable PRNG so battles are deterministic/replayable (important for
// server-authoritative online play). mulberry32: small, fast, good enough.
export class RNG {
  constructor(seed = (Math.random() * 2 ** 32) >>> 0) {
    this.seed = seed >>> 0;
    this.initial = this.seed;
  }
  // float in [0, 1)
  next() {
    let t = (this.seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  // integer in [min, max] inclusive
  int(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  // true with probability p (0..1)
  chance(p) {
    return this.next() < p;
  }
  // "x in y" odds, e.g. chanceIn(85, 256)
  chanceIn(x, y) {
    return this.next() < x / y;
  }
  pick(arr) {
    return arr[this.int(0, arr.length - 1)];
  }
}
