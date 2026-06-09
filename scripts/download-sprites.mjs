// Downloads HeartGold/SoulSilver front + back sprites for #1-251 from the
// PokeAPI sprites repo so the game works fully offline. These are the cleaner,
// higher-fidelity Gen 4 remake sprites (transparent 80x80 PNGs).
import { writeFile, mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(__dirname, '..', 'assets', 'sprites');
const REPO = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-iv/heartgold-soulsilver';
const CONCURRENCY = 16;

const exists = (p) => access(p).then(() => true, () => false);

async function download(url, dest) {
  if (await exists(dest)) return 'skip';
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        await writeFile(dest, Buffer.from(await res.arrayBuffer()));
        return 'ok';
      }
      if (res.status === 404) return '404';
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 300 * (i + 1)));
  }
  return 'fail';
}

async function main() {
  await mkdir(join(ASSETS, 'front'), { recursive: true });
  await mkdir(join(ASSETS, 'back'), { recursive: true });

  const jobs = [];
  for (let id = 1; id <= 251; id++) {
    jobs.push({ url: `${REPO}/${id}.png`, dest: join(ASSETS, 'front', `${id}.png`), id, kind: 'front' });
    jobs.push({ url: `${REPO}/back/${id}.png`, dest: join(ASSETS, 'back', `${id}.png`), id, kind: 'back' });
  }

  const stats = { ok: 0, skip: 0, '404': 0, fail: 0 };
  const failures = [];
  const queue = [...jobs];
  async function worker() {
    while (queue.length) {
      const j = queue.shift();
      const r = await download(j.url, j.dest);
      stats[r] = (stats[r] || 0) + 1;
      if (r === '404' || r === 'fail') failures.push(`#${j.id} ${j.kind} (${r})`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log('Sprite download complete:', JSON.stringify(stats));
  if (failures.length) console.log('Issues:', failures.join(', '));
}

main().catch((e) => { console.error(e); process.exit(1); });
