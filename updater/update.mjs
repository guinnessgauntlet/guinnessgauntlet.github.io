// Guinness Gauntlet score updater.
// Pulls regular-season records from ESPN's public standings feeds and F1 driver standings from the
// Jolpica (Ergast) API, then writes them to Firestore for the site to show live.
// Run by GitHub Actions every hour. Locally: `node update.mjs --dry-run` prints what it found without writing.
import fs from 'node:fs/promises';

const DRY = process.argv.includes('--dry-run');
const FIXTURES = process.env.GG_FIXTURES || null; // folder of saved JSON responses, for testing
const seasons = JSON.parse(await fs.readFile(new URL('./seasons.json', import.meta.url), 'utf8'));

// x = the "partial result" column: NFL ties, NHL overtime losses, Premier League draws.
const LEAGUES = {
  nfl: { label: 'NFL', path: 'football/nfl', x: ['ties'], xw: 0.5 },
  nba: { label: 'NBA', path: 'basketball/nba' },
  nhl: { label: 'NHL', path: 'hockey/nhl', x: ['otlosses', 'overtimelosses', 'otl'], xw: 0.5 },
  mlb: { label: 'MLB', path: 'baseball/mlb' },
  epl: { label: 'EPL', path: 'soccer/eng.1', x: ['ties', 'draws'], xw: 1 / 3, table: true },
};

// Must match slug() in index.html exactly.
const slug = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/ø/g, 'o').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const rid = (sport, team) => `${sport}__${slug(team)}`;

async function getJSON(url, fixture) {
  if (FIXTURES) {
    try { return JSON.parse(await fs.readFile(`${FIXTURES}/${fixture}.json`, 'utf8')); } catch { return null; }
  }
  const res = await fetch(url, { headers: { 'user-agent': 'guinness-gauntlet-updater/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// ESPN nests standings in conferences/divisions; gather every entry at any depth.
function collect(node, out = [], seasonsSeen = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(n => collect(n, out, seasonsSeen)); return out; }
  if (node.standings) {
    if (node.standings.season) seasonsSeen.add(Number(node.standings.season));
    if (Array.isArray(node.standings.entries)) out.push(...node.standings.entries);
  }
  if (node.children) collect(node.children, out, seasonsSeen);
  out.seasonsSeen = seasonsSeen;
  return out;
}
function stat(entry, names) {
  for (const s of entry.stats || []) {
    const keys = [s.name, s.type, s.abbreviation].filter(Boolean).map(k => String(k).toLowerCase());
    if (names.some(n => keys.includes(n))) {
      const v = Number(s.value ?? s.displayValue);
      if (Number.isFinite(v)) return v;
    }
  }
  return null;
}

async function fetchLeague(id) {
  const L = LEAGUES[id], season = seasons[id];
  const url = `https://site.api.espn.com/apis/v2/sports/${L.path}/standings?season=${season}`;
  const json = await getJSON(url, id);
  if (!json) return null;
  const entries = collect(json);
  const seen = entries.seasonsSeen || new Set();
  if (seen.size && !seen.has(Number(season))) {
    console.log(`  ${L.label}: feed returned season ${[...seen].join('/')} instead of ${season}; skipping until it starts.`);
    return null;
  }
  const byTeam = new Map();
  for (const e of entries) {
    const name = e.team?.displayName || e.team?.name; if (!name) continue;
    const key = e.team?.id || name; if (byTeam.has(key)) continue;
    const w = stat(e, ['wins', 'w']) ?? 0, l = stat(e, ['losses', 'l']) ?? 0, x = L.x ? (stat(e, L.x) ?? 0) : 0;
    const row = { team: name, w, l, x };
    if (L.table) { row.pos = stat(e, ['rank']) ?? null; row.pts = stat(e, ['points', 'p']) ?? null; }
    byTeam.set(key, row);
  }
  const rows = [...byTeam.values()];
  if (!rows.length) return null;
  if (L.table && rows.some(r => !r.pos)) { // fall back to ordering by points
    rows.sort((a, b) => (b.pts ?? 3 * b.w + b.x) - (a.pts ?? 3 * a.w + a.x)).forEach((r, i) => { r.pos = i + 1; });
  }
  const pct = r => { const gp = r.w + r.l + r.x; return gp ? (r.w + (L.xw || 0) * r.x) / gp : null; };
  const played = rows.filter(r => pct(r) != null);
  const top = played.length ? Math.max(...played.map(pct)) : null;
  const best = top == null ? [] : played.filter(r => Math.abs(pct(r) - top) < 1e-9).map(r => r.team);
  return { rows, best };
}

async function fetchF1() {
  const year = seasons.f1;
  const json = await getJSON(`https://api.jolpi.ca/ergast/f1/${year}/driverstandings.json`, 'f1');
  const list = json?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings;
  if (!list?.length) { console.log(`  F1: no ${year} standings yet; skipping.`); return null; }
  const rows = list.map(d => ({
    team: `${d.Driver?.givenName ?? ''} ${d.Driver?.familyName ?? ''}`.trim(),
    pos: Number(d.position || d.positionText) || null, pts: Number(d.points) || 0, wins: Number(d.wins) || 0,
  })).filter(r => r.team);
  return { rows, best: rows.filter(r => r.pos === 1).map(r => r.team) };
}

// Match a drafted name to a feed name ("Saints" → "New Orleans Saints", "Kimi Antonelli" → "Andrea Kimi Antonelli").
function matchRow(rows, pickName) {
  const p = slug(pickName);
  return rows.find(r => slug(r.team) === p)
    || rows.find(r => slug(r.team).endsWith('-' + p) || p.endsWith('-' + slug(r.team)))
    || (() => { const hits = rows.filter(r => slug(r.team).includes(p) || p.includes(slug(r.team))); return hits.length === 1 ? hits[0] : null; })()
    || (() => { const last = p.split('-').pop(); const hits = rows.filter(r => slug(r.team).split('-').pop() === last); return hits.length === 1 ? hits[0] : null; })();
}

const same = (a, b) => ['w', 'l', 'x', 'pos', 'pts'].every(k => (a?.[k] ?? null) === (b?.[k] ?? null)) && a?.team === b?.team;

async function main() {
  let db = null, admin = null;
  if (!DRY) {
    admin = (await import('firebase-admin')).default;
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT secret is missing. Add it under GitHub → Settings → Secrets and variables → Actions.');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
    db = admin.firestore();
  }

  const picks = db ? (await db.collection('picks').get()).docs.map(d => d.data()) : [];
  const existing = new Map();
  if (db) (await db.collection('results').get()).docs.forEach(d => existing.set(d.id, d.data()));

  const writes = []; const updated = []; const problems = [];
  const sports = [...Object.keys(LEAGUES), 'f1'];
  for (const sport of sports) {
    const label = LEAGUES[sport]?.label || 'F1';
    let data;
    try { data = sport === 'f1' ? await fetchF1() : await fetchLeague(sport); }
    catch (e) { console.log(`  ${label}: ${e.message}`); problems.push(`${label} feed down`); continue; }
    if (!data) continue;

    const docs = new Map(); // id → fields
    for (const r of data.rows) docs.set(rid(sport, r.team), { sport, team: r.team, w: r.w ?? null, l: r.l ?? null, x: r.x ?? null, pos: r.pos ?? null, pts: r.pts ?? null, feed: true });
    const best = new Set(data.best);
    for (const p of picks.filter(p => p.sport === sport)) {
      const id = rid(sport, p.team); if (docs.has(id)) continue;
      const row = matchRow(data.rows, p.team);
      if (!row) { problems.push(`no match for ${p.team}`); continue; }
      docs.set(id, { ...docs.get(rid(sport, row.team)), team: p.team, feed: false });
      if (best.has(row.team)) best.add(p.team);
    }
    let changed = 0;
    for (const [id, fields] of docs) if (!same(fields, existing.get(id))) { writes.push(['results/' + id, fields]); changed++; }
    writes.push(['meta/' + sport, { best: [...best], teams: data.rows.length, season: seasons[sport] }]);
    updated.push(label);
    const show = data.rows.slice().sort((a, b) => (a.pos ?? 99) - (b.pos ?? 99)).slice(0, 3)
      .map(r => r.pos ? `${r.pos}. ${r.team} (${r.pts})` : `${r.team} ${r.w}-${r.l}${r.x ? '-' + r.x : ''}`).join(', ');
    console.log(`  ${label}: ${data.rows.length} teams/drivers, ${changed} changed. Best: ${[...best].join(' / ') || '—'}. e.g. ${show}`);
  }

  const note = (updated.length ? updated.join(', ') + ' updated' : 'No seasons in progress') + (problems.length ? ' · ' + problems.slice(0, 3).join(', ') : '');
  writes.push(['sync/main', { at: new Date().toISOString(), note: note.slice(0, 120) }]);

  if (DRY) { console.log(`Dry run: would write ${writes.length} documents. Note: "${note}"`); return; }
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch();
    for (const [path, fields] of writes.slice(i, i + 400)) batch.set(db.doc(path), fields, { merge: true });
    await batch.commit();
  }
  console.log(`Wrote ${writes.length} documents. ${note}`);
}

main().catch(e => { console.error(e); process.exit(1); });
