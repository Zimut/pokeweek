// Browser-side loader for the generated world content (built by
// `npm run build:world` into /src/data/world). Returns one bundle object that
// the overworld engine, encounter/catch system, battles, mart, and lobby all
// read from. Pure data — no engine logic here.
const WORLD = 'src/data/world';

export async function loadWorld() {
  const files = ['progression', 'maps', 'encounters', 'trainers', 'gyms', 'mart', 'evolution'];
  const parts = await Promise.all(
    files.map((f) => fetch(`${WORLD}/${f}.json`).then((r) => {
      if (!r.ok) throw new Error(`Failed to load world/${f}.json (${r.status}). Run "npm run build:world".`);
      return r.json();
    })),
  );
  const [progression, maps, encounters, trainers, gyms, mart, evolution] = parts;
  // Index maps by their numeric id for O(1) lookup.
  const mapById = {};
  for (const m of maps) mapById[m.map] = m;
  return { progression, maps, mapById, encounters, trainers, gyms, mart, evolution };
}
