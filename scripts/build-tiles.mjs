// Slices the tall-grass tuft and the gym/mart building sheet (scripts/art/*) into
// the tiles the overworld paints, in assets/tiles/. Offline: our PNG codec
// (scripts/_png.mjs) does decode/encode. Run with:  npm run build:tiles
//
//   grass-src.png   -> grass.png        (a single tuft, alpha-tightened)
//   buildings-src.png contains three structures (flood-fill bboxes):
//     left  blue-grey  -> mart.png      (Poké Mart)
//     right red        -> gym-k.png     (Kanto gym)
//     lower brown      -> gym-j.png     (Johto gym)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decodePng, encodePng, crop, alphaAt } from './_png.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ART = join(__dirname, 'art');
const OUT = join(__dirname, '..', 'assets', 'tiles');
mkdirSync(OUT, { recursive: true });

// Alpha bounding box (alpha > 16) of a whole image.
function bbox(img) {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (alphaAt(img, x, y) > 16) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function save(name, img) {
  writeFileSync(join(OUT, name), encodePng(img.width, img.height, img.data));
  return `${name} (${img.width}x${img.height})`;
}

// --- grass -----------------------------------------------------------------
// The provided grass art (grass-src.png) is a single connected *field* of
// overlapping blades that fills its whole canvas, so tiling it always slices
// blades at the seams. Instead we synthesize one clean tuft: a small clump of
// blades, centred with transparent padding (so a 2x2 repeat never cuts a blade)
// and a soft shadow baked underneath. The overworld paints it over the normal
// floor — no separate green slab.
function buildGrassTuft() {
  const S = 32;
  const data = Buffer.alloc(S * S * 4);
  const px = (x, y, r, g, b, a) => {            // straight-alpha "over" blend
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= S || y >= S || a <= 0) return;
    const i = (y * S + x) * 4, da = data[i + 3] / 255, oa = a + da * (1 - a);
    if (oa <= 0) return;
    data[i]     = Math.round((r * a + data[i]     * da * (1 - a)) / oa);
    data[i + 1] = Math.round((g * a + data[i + 1] * da * (1 - a)) / oa);
    data[i + 2] = Math.round((b * a + data[i + 2] * da * (1 - a)) / oa);
    data[i + 3] = Math.round(oa * 255);
  };
  // The whole tuft is drawn around the base point (CX, BASEY) and scaled by
  // SCALE — bigger blades from the same ground spot, so the overworld's 2x2
  // tiling keeps every tuft in exactly the same place, just larger.
  const SCALE = 1.2, CX = 16, BASEY = 24;
  // soft shadow ellipse at the base
  const scx = CX, scy = 26, srx = 10 * SCALE, sry = 3 * SCALE;
  for (let y = Math.floor(scy - sry - 1); y <= Math.ceil(scy + sry + 1); y++)
    for (let x = Math.floor(scx - srx - 1); x <= Math.ceil(scx + srx + 1); x++) {
      const d = Math.hypot((x - scx) / srx, (y - scy) / sry);
      if (d <= 1) px(x, y, 24, 44, 20, 0.22 * (1 - d));
    }
  // blades, back (dark) to front (light); each is a tapered, leaning stroke.
  const C = { light: [126, 200, 80], mid: [80, 168, 63], dark: [54, 128, 48], line: [40, 96, 40] };
  const blades = [
    [15, -6, 12, 1.6, 'dark'], [18, 5, 13, 1.6, 'dark'], [13, -8, 10, 1.5, 'mid'],
    [19, 8, 11, 1.5, 'mid'], [16, -3, 15, 2, 'mid'], [17, 3, 14, 1.6, 'light'],
    [16, 1, 17, 2, 'light'],
  ];
  for (const [bx, lean, h, bh, shade] of blades) {
    const col = C[shade], steps = Math.max(8, Math.round(h * SCALE * 2));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const y = BASEY - t * h * SCALE;
      const x = CX + ((bx - CX) + lean * t * t) * SCALE;
      const hw = bh * (1 - t) * SCALE + 0.4;
      for (let dx = -hw - 0.7; dx <= hw + 0.7; dx += 0.5) px(x + dx, y, C.line[0], C.line[1], C.line[2], 0.9);
      for (let dx = -hw; dx <= hw; dx += 0.5) px(x + dx, y, col[0], col[1], col[2], 1);
    }
  }
  return { width: S, height: S, data };
}
const out = [save('grass.png', buildGrassTuft())];

// --- buildings: three flood-fill components (bboxes found by inspection) -----
const blds = decodePng(readFileSync(join(ART, 'buildings-src.png')));
// Connected-component bounding boxes (opaque > 40), to isolate each building.
function components(img) {
  const W = img.width, H = img.height, seen = new Uint8Array(W * H), out = [];
  const op = (x, y) => alphaAt(img, x, y) > 40;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const idx = y * W + x;
    if (seen[idx] || !op(x, y)) continue;
    let minX = x, maxX = x, minY = y, maxY = y, n = 0, stack = [idx]; seen[idx] = 1;
    while (stack.length) {
      const p = stack.pop(), px = p % W, py = (p / W) | 0; n++;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      for (const [nx, ny] of [[px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]]) {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (!seen[ni] && op(nx, ny)) { seen[ni] = 1; stack.push(ni); }
      }
    }
    if (n > 2000) out.push({ minX, minY, maxX, maxY });
  }
  // sort top-to-bottom, then left-to-right: [mart(top-left), gym-k(top-right), gym-j(bottom)]
  return out.sort((a, b) => a.minY - b.minY || a.minX - b.minX);
}
const comps = components(blds);
if (comps.length !== 3) throw new Error(`expected 3 buildings, found ${comps.length}`);
const names = ['mart.png', 'gym-k.png', 'gym-j.png'];
comps.forEach((c, i) => {
  out.push(save(names[i], crop(blds, c.minX, c.minY, c.maxX - c.minX + 1, c.maxY - c.minY + 1)));
});

console.log('Tiles built → assets/tiles/:\n - ' + out.join('\n - '));
