// Slices Blake's overworld character sheet (scripts/art/characters-src.png) into
// the per-character 2x3 atlases the overworld + lobby expect, one PNG per id in
// assets/characters/. Fully offline: our hand-rolled PNG codec (scripts/_png.mjs,
// Node's zlib) does decode/encode — no image libraries.
//
// Source layout (384x384): 9 horizontal rows of characters, each row holding 3
// character "groups" of 4 poses. Pose order within a group is
//   p0 = facing down (front),  p1 = right,  p2 = up (back),  p3 = left
// (verified by luminance inspection: p0 shows a face, p2 shows plain hair, p1/p3
// are mirror profiles). We only need front/back/left — right is the left row
// mirrored in CSS (.face-right { scaleX(-1) }).
//
// Output atlas = 2 cols x 3 rows of square cells:
//   row 0 = down,  row 1 = up,  row 2 = left   (CSS background-size 200% 300%)
//   col 0 / col 1 = walk frame A / B — Blake's sheet has a single standing pose
//   per direction, so both columns get the same sprite (static, no leg cycle).
// Each pose is tightened to its alpha bbox, then placed bottom-aligned and
// horizontally centered in the square cell so feet line up across facings.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decodePng, encodePng, alphaAt } from './_png.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, 'art', 'characters-src.png');
const OUT = join(__dirname, '..', 'assets', 'characters');
mkdirSync(OUT, { recursive: true });

const img = decodePng(readFileSync(SRC));

// The 9 row strips (head .. feet), read off the sheet's vertical density profile.
const ROW_STRIPS = [
  [6, 46], [47, 88], [89, 128], [130, 171], [172, 211],
  [212, 252], [254, 292], [293, 333], [341, 379],
];

// Pose order inside a group, and which output sheet-row each maps to.
const DOWN = 0, UP = 2, LEFT = 3;

// id -> { row, group }. Each row splits cleanly into 12 columns (3 groups x 4
// poses); we hand-pick ten that read as distinct, clean single trainers (each
// front shows a face + two feet) — avoiding the few cells that are unusually
// wide or sit too close to a neighbour to separate without bleed.
const MAP = {
  red:    { row: 1, group: 0 }, blue:   { row: 1, group: 1 }, green: { row: 1, group: 2 },
  gold:   { row: 3, group: 0 }, silver: { row: 7, group: 1 }, kris:  { row: 3, group: 2 },
  'npc-0': { row: 2, group: 0 }, 'npc-1': { row: 5, group: 1 }, 'npc-2': { row: 2, group: 2 },
  'npc-3': { row: 7, group: 0 },
};

// --- column detection: split a row strip into its 12 sprite x-runs -----------
function runsOver(arr, thr) {
  const out = []; let s = -1;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > thr) { if (s < 0) s = i; }
    else { if (s >= 0) { out.push([s, i - 1]); s = -1; } }
  }
  if (s >= 0) out.push([s, arr.length - 1]);
  return out;
}
function detectCols(y0, y1) {
  const colHas = new Array(img.width).fill(0);
  for (let x = 0; x < img.width; x++)
    for (let y = y0; y <= y1; y++)
      if (alphaAt(img, x, y) > 16) colHas[x]++;
  const cb = runsOver(colHas, 0).filter(([a, b]) => b - a + 1 >= 6); // drop specks
  const split = [];
  for (const [a, b] of cb) {                                          // split merges
    const w = b - a + 1;
    if (w > 40) {
      let mi = a + Math.floor(w * 0.5), mv = Infinity;
      for (let x = a + Math.floor(w * 0.3); x <= a + Math.ceil(w * 0.7); x++)
        if (colHas[x] < mv) { mv = colHas[x]; mi = x; }
      split.push([a, mi], [mi + 1, b]);
    } else split.push([a, b]);
  }
  return split;
}

// Adjacent poses occasionally touch, so a detected x-run can carry a thin
// sliver of the neighbour. Trim edge columns whose alpha coverage is well below
// the pose's peak (≤6 per side, so a real body edge is never eaten).
function trimEdges(cx0, cx1, sy0, sy1) {
  let peak = 0; const cnt = new Array(cx1 - cx0 + 1).fill(0);
  for (let x = cx0; x <= cx1; x++) {
    let c = 0; for (let y = sy0; y <= sy1; y++) if (alphaAt(img, x, y) > 16) c++;
    cnt[x - cx0] = c; if (c > peak) peak = c;
  }
  const thr = peak * 0.3;
  let a = cx0, b = cx1, la = 0, lb = 0;
  while (a < b && cnt[a - cx0] < thr && la < 6) { a++; la++; }
  while (b > a && cnt[b - cx0] < thr && lb < 6) { b--; lb++; }
  return [a, b];
}

// Tight bbox of one pose within its row strip + given x-run.
function poseBox(row, group, pose) {
  const [sy0, sy1] = ROW_STRIPS[row];
  const cols = detectCols(sy0, sy1);
  const run = cols[group * 4 + pose];
  if (!run) throw new Error(`row ${row} has ${cols.length} cols (need ${group * 4 + pose + 1})`);
  const [cx0, cx1] = trimEdges(run[0], run[1], sy0, sy1);
  let x0 = cx1, x1 = cx0, y0 = sy1, y1 = sy0;
  for (let y = sy0; y <= sy1; y++)
    for (let x = cx0; x <= cx1; x++)
      if (alphaAt(img, x, y) > 16) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// --- size the square cell to the largest pose we place -----------------------
const NEEDED = [DOWN, UP, LEFT];
let maxDim = 0;
for (const { row, group } of Object.values(MAP))
  for (const p of NEEDED) {
    const b = poseBox(row, group, p);
    maxDim = Math.max(maxDim, b.w, b.h);
  }
const CELL = maxDim + 2;                 // 1px breathing room on the tighter axis
const BOTTOM = Math.round(CELL * 0.08);  // small gap so feet sit over the shadow
const SHEET_W = CELL * 2, SHEET_H = CELL * 3;

// Blit a pose into cell (sheetRow), both columns, bottom-aligned + h-centered.
function blit(buf, row, group, pose, sheetRow) {
  const b = poseBox(row, group, pose);
  const ox = Math.round((CELL - b.w) / 2);
  const oy = CELL - BOTTOM - b.h;
  for (let col = 0; col < 2; col++) {
    const baseX = col * CELL + ox, baseY = sheetRow * CELL + oy;
    for (let y = 0; y < b.h; y++)
      for (let x = 0; x < b.w; x++) {
        const si = ((b.y0 + y) * img.width + (b.x0 + x)) * 4;
        if (img.data[si + 3] < 16) continue;
        const di = ((baseY + y) * SHEET_W + (baseX + x)) * 4;
        buf[di] = img.data[si]; buf[di + 1] = img.data[si + 1];
        buf[di + 2] = img.data[si + 2]; buf[di + 3] = img.data[si + 3];
      }
  }
}

let n = 0;
for (const [id, { row, group }] of Object.entries(MAP)) {
  const buf = Buffer.alloc(SHEET_W * SHEET_H * 4);
  blit(buf, row, group, DOWN, 0);
  blit(buf, row, group, UP, 1);
  blit(buf, row, group, LEFT, 2);
  writeFileSync(join(OUT, `${id}.png`), encodePng(SHEET_W, SHEET_H, buf));
  n++;
}
console.log(`Character sheets built: ${n} files (${SHEET_W}x${SHEET_H}, cell ${CELL}) → assets/characters/`);
