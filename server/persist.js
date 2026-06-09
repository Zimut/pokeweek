// File-based JSON persistence for lobbies. Each lobby is one file:
//   saves/<code>.json
// Writes are debounced (coalesce a burst of state changes into one disk write)
// and atomic (write to a temp file, then rename) so a crash mid-write can't
// corrupt a save. On boot the server loads every save back into memory, so a
// week-long game survives both a browser refresh AND a full server restart.
//
// Zero dependencies — just node:fs/promises.
import { readFile, writeFile, mkdir, readdir, rename, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SAVES_DIR = join(__dirname, '..', 'saves');

const DEBOUNCE_MS = 400;
const timers = new Map(); // code -> { timer, getData }

async function ensureDir() {
  await mkdir(SAVES_DIR, { recursive: true });
}

// Load every saved lobby on boot. Returns { code: lobbyData }. Corrupt or
// partially-written files are skipped rather than crashing the server.
export async function loadAllSaves() {
  await ensureDir();
  const files = await readdir(SAVES_DIR).catch(() => []);
  const out = {};
  for (const f of files) {
    if (!f.endsWith('.json')) continue; // ignore .tmp and anything else
    try {
      const data = JSON.parse(await readFile(join(SAVES_DIR, f), 'utf8'));
      if (data && typeof data.code === 'string') out[data.code] = data;
    } catch { /* skip corrupt save */ }
  }
  return out;
}

// Atomic write: temp file + rename. Avoids readers ever seeing a half file.
export async function writeSave(code, data) {
  await ensureDir();
  const dest = join(SAVES_DIR, `${code}.json`);
  const tmp = `${dest}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, dest);
}

// Coalesce rapid state changes into a single write. `getData` is called at
// flush time so the very latest snapshot is what hits disk.
export function scheduleSave(code, getData) {
  const existing = timers.get(code);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    timers.delete(code);
    writeSave(code, getData()).catch((err) => {
      if (process.env.PW_DEBUG) console.error('[persist] write failed', code, err && err.message);
    });
  }, DEBOUNCE_MS);
  if (typeof timer.unref === 'function') timer.unref(); // don't keep node alive
  timers.set(code, { timer, getData });
}

// Force every pending debounced write to disk immediately (e.g. on shutdown).
export async function flushAll() {
  const pending = [...timers.entries()];
  timers.clear();
  await Promise.all(pending.map(([code, { timer, getData }]) => {
    clearTimeout(timer);
    return writeSave(code, getData()).catch(() => {});
  }));
}

export async function deleteSave(code) {
  const existing = timers.get(code);
  if (existing) { clearTimeout(existing.timer); timers.delete(code); }
  await unlink(join(SAVES_DIR, `${code}.json`)).catch(() => {});
}
