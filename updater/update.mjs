// Guinness Gauntlet score updater.
// Every hour (via GitHub Actions) it pulls, from free public feeds:
//   • regular-season records and table positions (ESPN: NFL, NBA, NHL, MLB, Premier League)
//   • when each regular season has ended
//   • playoff progress, round by round (ESPN scoreboards)
//   • F1 drivers' championship standings (Jolpica / Ergast)
//   • golf major finishes and tennis Grand Slam results (ESPN)
// and writes them to Firestore for the site.
// It handles every Gauntlet season that's still running (when season N+1 starts in March, season N
// keeps scoring until June). Season 1 uses seasons.json; later seasons work out their own years.
// Locally: `node update.mjs --dry-run` prints what it found without writing anything.
import fs from 'node:fs/promises';

const DRY = process.argv.includes('--dry-run');
const FIXTURES = process.env.GG_FIXTURES || null; // folder of saved JSON responses, for testing
const NOW = process.env.GG_NOW ? new Date(process.env.GG_NOW) : new Date();
const SEASON1 = JSON.parse(await fs.readFile(new URL('./seasons.json', import.meta.url), 'utf8'));
// Years each league counts in Gauntlet season k. Season k (2+) starts at MLB opening day of year Y = 2025 + k:
// NFL/EPL seasons starting in Y, NBA/NHL seasons ending in Y+1, MLB/F1/golf in Y,
// tennis French Open, Wimbledon and US Open in Y plus the next Australian Open (Y+1).
// Season 1 (2026–27) only had the Australian Open 2027.
function yearsFor(k) {
  if (k === 1) return { ...SEASON1, slams: [SEASON1.tennis, null, null, null] };
  const Y = 2025 + k;
  return { nfl: Y, nba: Y + 1, nhl: Y + 1, mlb: Y, epl: Y, f1: Y, golf: Y, tennis: Y, slams: [Y + 1, Y, Y, Y] };
}
const seasonEnd = k => (k === 1 ? '20270620' : `${2026 + k}0620`);
const prefix = k => (k === 1 ? '' : `s${k}~`);
let seasons = yearsFor(1); // the season being processed (set in main)
const ESPN = 'https://site.api.espn.com/apis';

const LEAGUES = {
  nfl: { label: 'NFL', path: 'football/nfl', x: ['ties'], xw: 0.5, games: 17, post: s => [`${s + 1}0101`, `${s + 1}0220`], need: [0, 1, 1, 1, 1] },
  nba: { label: 'NBA', path: 'basketball/nba', games: 82, post: s => [`${s}0410`, `${s}0630`], need: [0, 4, 4, 4, 4] },
  nhl: { label: 'NHL', path: 'hockey/nhl', x: ['otlosses', 'overtimelosses', 'otl'], xw: 0.5, games: 84, post: s => [`${s}0410`, `${s}0630`], need: [0, 4, 4, 4, 4] },
  mlb: { label: 'MLB', path: 'baseball/mlb', games: 162, slack: 2, post: s => [`${s}0925`, `${s}1110`], need: [0, 2, 3, 4, 4] },
  epl: { label: 'EPL', path: 'soccer/eng.1', x: ['ties', 'draws'], xw: 1 / 3, games: 38, table: true },
};
const MAJORS = [/masters/i, /pga championship/i, /u\.?\s?s\.? open/i, /(^|\s)the open|open championship|british open/i];
const SLAMS = [
  { re: /australian open/i, win: s => [`${s}0110`, `${s}0205`] },
  { re: /roland|french open/i, win: s => [`${s}0520`, `${s}0615`] },
  { re: /wimbledon/i, win: s => [`${s}0625`, `${s}0720`] },
  { re: /u\.?\s?s\.? open/i, win: s => [`${s}0820`, `${s}0915`] },
];

// Must match slug() in index.html exactly.
const slug = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/ø/g, 'o').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const rid = (sport, team) => `${sport}__${slug(team)}`;
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const today = ymd(NOW);
const log = (...a) => console.log('  ' + a.join(' '));

async function getJSON(url, fixture) {
  if (FIXTURES) {
    try { return JSON.parse(await fs.readFile(`${FIXTURES}/${fixture}.json`, 'utf8')); } catch { return null; }
  }
  const res = await fetch(url, { headers: { 'user-agent': 'guinness-gauntlet-updater/1.1' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

/* ---------- regular season ---------- */
function collect(node, out = [], seen = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(n => collect(n, out, seen)); return out; }
  if (node.standings) {
    if (node.standings.season) seen.add(Number(node.standings.season));
    if (Array.isArray(node.standings.entries)) out.push(...node.standings.entries);
  }
  if (node.children) collect(node.children, out, seen);
  out.seasonsSeen = seen;
  return out;
}
function stat(entry, names) {
  for (const s of entry.stats || []) {
    const keys = [s.name, s.type, s.abbreviation].filter(Boolean).map(k => String(k).toLowerCase());
    if (names.some(n => keys.includes(n))) { const v = Number(s.value ?? s.displayValue); if (Number.isFinite(v)) return v; }
  }
  return null;
}
async function fetchLeague(id, seasonOverride) {
  const L = LEAGUES[id], season = seasonOverride ?? seasons[id];
  const json = await getJSON(`${ESPN}/v2/sports/${L.path}/standings?season=${season}`, seasonOverride ? id + '-prev' : id);
  if (!json) return null;
  const entries = collect(json);
  const seen = entries.seasonsSeen || new Set();
  if (seen.size && !seen.has(Number(season))) { log(`${L.label}: feed is still on season ${[...seen].join('/')}; waiting for ${season}.`); return null; }
  const byTeam = new Map();
  for (const e of entries) {
    const name = e.team?.displayName || e.team?.name; if (!name) continue;
    const key = e.team?.id || name; if (byTeam.has(key)) continue;
    const row = { team: name, espnId: String(e.team?.id || ''), w: stat(e, ['wins', 'w']) ?? 0, l: stat(e, ['losses', 'l']) ?? 0, x: L.x ? (stat(e, L.x) ?? 0) : 0 };
    if (L.table) { row.pos = stat(e, ['rank']) ?? null; row.pts = stat(e, ['points', 'p']) ?? null; }
    byTeam.set(key, row);
  }
  const rows = [...byTeam.values()];
  if (!rows.length) return null;
  if (L.table && rows.some(r => !r.pos)) rows.sort((a, b) => (b.pts ?? 3 * b.w + b.x) - (a.pts ?? 3 * a.w + a.x)).forEach((r, i) => { r.pos = i + 1; });
  const pct = r => { const gp = r.w + r.l + r.x; return gp ? (r.w + (L.xw || 0) * r.x) / gp : null; };
  const played = rows.filter(r => pct(r) != null);
  const top = played.length ? Math.max(...played.map(pct)) : null;
  const best = top == null ? [] : played.filter(r => Math.abs(pct(r) - top) < 1e-9).map(r => r.team);
  const low = played.length ? Math.min(...played.map(pct)) : null;
  const worst = low == null ? [] : played.filter(r => Math.abs(pct(r) - low) < 1e-9).map(r => r.team);
  const done = rows.every(r => r.w + r.l + r.x >= L.games - (L.slack || 0));
  return { rows, best, worst, done };
}

/* ---------- playoffs ---------- */
// Round 1–4 from ESPN's game headline. 0 = not a counted playoff game (play-in, Pro Bowl).
function roundOf(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  if (/play-?in|pro bowl/.test(t)) return 0;
  if (/super bowl|nba finals|stanley cup final|world series/.test(t)) return 4;
  if (/semifinal|divisional|division series|alds|nlds|2nd round|second round/.test(t)) return 2;
  if (/wild ?card|1st round|first round/.test(t)) return 1;
  if (/conference|conf\.|alcs|nlcs|league championship|championship series|afc championship|nfc championship/.test(t)) return 3;
  return null;
}
async function fetchPlayoffs(id) {
  const L = LEAGUES[id]; if (!L.post) return null;
  const [a, b] = L.post(seasons[id]);
  if (today < a) return null;
  const json = await getJSON(`${ESPN}/site/v2/sports/${L.path}/scoreboard?seasontype=3&dates=${a}-${b}&limit=1000`, id + '-post');
  const events = json?.events || [];
  if (!events.length) return null;
  const reached = new Map(), out = new Map(), tally = new Map(); let champion = null, unknown = 0;
  for (const ev of events) {
    const comp = ev.competitions?.[0]; if (!comp) continue;
    const r = roundOf(comp.notes?.[0]?.headline || ev.name);
    const teams = (comp.competitors || []).map(c => ({ name: c.team?.displayName, winner: c.winner === true })).filter(t => t.name);
    if (r == null) { unknown++; continue; }
    if (r === 0 || teams.length !== 2) continue;
    teams.forEach(t => reached.set(t.name, Math.max(reached.get(t.name) || 0, r)));
    const completed = comp.status?.type?.completed ?? ev.status?.type?.completed;
    const w = teams.find(t => t.winner); if (!completed || !w) continue;
    const key = r + '|' + teams.map(t => t.name).sort().join('|');
    const tl = tally.get(key) || {}; tl[w.name] = (tl[w.name] || 0) + 1; tally.set(key, tl);
    if (tl[w.name] >= L.need[r]) { // series (or single game) decided
      const loser = teams.find(t => t.name !== w.name).name;
      out.set(loser, r);
      if (r === 4) champion = w.name;
    }
  }
  if (unknown) log(`${L.label}: ${unknown} playoff games had no recognizable round name.`);
  const stage = new Map();
  for (const [team, r] of reached) stage.set(team, team === champion ? 5 : (out.get(team) ?? r));
  return { stage };
}

/* ---------- F1 ---------- */
async function fetchF1(yearOverride) {
  const year = yearOverride ?? seasons.f1;
  const json = await getJSON(`https://api.jolpi.ca/ergast/f1/${year}/driverstandings.json`, yearOverride ? 'f1-prev' : 'f1');
  const list = json?.MRData?.StandingsTable?.StandingsLists?.[0];
  if (!list?.DriverStandings?.length) { log(`F1: no ${year} standings yet.`); return null; }
  const rows = list.DriverStandings.map(d => ({
    team: `${d.Driver?.givenName ?? ''} ${d.Driver?.familyName ?? ''}`.trim(),
    pos: Number(d.position || d.positionText) || null, pts: Number(d.points) || 0,
  })).filter(r => r.team);
  let done = false, total = null;
  const round = Number(list.round) || null;
  try {
    const sched = await getJSON(`https://api.jolpi.ca/ergast/f1/${year}.json`, 'f1-schedule');
    total = Number(sched?.MRData?.total) || null;
    done = !!total && round >= total;
  } catch { /* schedule optional */ }
  const last = Math.max(...rows.map(r => r.pos || 0));
  return { rows, best: rows.filter(r => r.pos === 1).map(r => r.team), worst: rows.filter(r => r.pos === last).map(r => r.team), done, round, total };
}

/* ---------- golf ---------- */
function golfPos(c) {
  const st = c.status || {};
  const words = [st.type?.name, st.type?.description, st.displayValue, c.score?.displayValue].filter(Boolean).join(' ').toLowerCase();
  if (/withdr|\bwd\b|disq|\bdq\b/.test(words)) return 'WD';
  if (/\bcut\b|missed cut|\bmc\b/.test(words)) return 'MC';
  const p = st.position?.displayName || c.position?.displayName || (Number.isFinite(c.order) ? String(c.order) : '');
  return String(p).replace(/^=/, 'T').trim();
}
async function fetchGolf() {
  const year = seasons.golf;
  const cal = await getJSON(`${ESPN}/site/v2/sports/golf/pga/scoreboard?dates=${year}`, 'golf-calendar');
  const calendar = cal?.leagues?.[0]?.calendar || [];
  const results = []; // per major: {name→pos}, field
  for (let i = 0; i < 4; i++) {
    const ent = calendar.find(c => MAJORS[i].test(c.label || c.name || '') && String(c.startDate || '').startsWith(String(year)));
    if (!ent) { results.push(null); continue; }
    if (ent.endDate && new Date(ent.endDate) > NOW) { results.push(null); continue; }
    const json = await getJSON(`${ESPN}/site/v2/sports/golf/pga/scoreboard?event=${ent.id}`, `golf-${i}`);
    const ev = json?.events?.[0];
    if (!ev || !(ev.status?.type?.completed ?? ev.competitions?.[0]?.status?.type?.completed)) { results.push(null); continue; }
    const comps = ev.competitions?.[0]?.competitors || [];
    const map = new Map(comps.map(c => [c.athlete?.displayName || c.athlete?.fullName, golfPos(c)]).filter(([n]) => n));
    results.push({ name: ev.name, map, field: comps.length });
  }
  const got = results.filter(Boolean);
  if (!got.length) { log(`Golf: no ${year} majors finished yet.`); return null; }
  log(`Golf: ${got.map(r => `${r.name} (${r.field} players)`).join(', ')}`);
  return results;
}

/* ---------- tennis ---------- */
function tennisRound(text) {
  const t = String(text || '').toLowerCase();
  if (/qualif/.test(t)) return null;
  if (/semi/.test(t)) return 6; if (/quarter/.test(t)) return 5; if (/final/.test(t)) return 7;
  const of = t.match(/round of (\d+)/); if (of) return { 128: 1, 64: 2, 32: 3, 16: 4 }[of[1]] ?? null;
  const n = t.match(/(\d)(st|nd|rd|th)? round|round (\d)/); if (n) return Number(n[1] || n[3]);
  return null;
}
const CODES = ['', 'R128', 'R64', 'R32', 'R16', 'QF', 'SF', 'F'];
async function fetchTennis() {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const year = seasons.slams[i];
    if (!year) { out.push(null); continue; } // this Slam belongs to another Gauntlet season
    const [a, b] = SLAMS[i].win(year);
    if (today < a) { out.push(null); continue; }
    const res = new Map(); let finalDone = false, found = false;
    for (const tour of ['atp']) { // men's singles only
      const json = await getJSON(`${ESPN}/site/v2/sports/tennis/${tour}/scoreboard?dates=${a}-${b}&limit=1000`, `tennis-${tour}-${i}`);
      for (const ev of (json?.events || []).filter(e => SLAMS[i].re.test(e.name || e.shortName || ''))) {
        found = true;
        const groups = ev.groupings?.length ? ev.groupings : [{ grouping: { displayName: 'Singles' }, competitions: ev.competitions || [] }];
        for (const g of groups) {
          const gname = (g.grouping?.displayName || g.grouping?.slug || '').toLowerCase();
          if (/doubles|mixed|junior|qualif|wheelchair/.test(gname)) continue;
          for (const c of g.competitions || []) {
            const r = tennisRound(c.round?.displayName || c.round?.description || c.type?.text || c.notes?.[0]?.headline);
            if (!r) continue;
            const done = c.status?.type?.completed;
            for (const p of c.competitors || []) {
              const name = p.athlete?.displayName || p.athlete?.fullName || p.roster?.displayName; if (!name) continue;
              const prev = res.get(name);
              let code = CODES[r];
              if (done && p.winner === true) code = r === 7 ? 'W' : CODES[Math.min(r + 1, 7)];
              if (!prev || CODES.indexOf(code) > CODES.indexOf(prev) || code === 'W') res.set(name, code);
            }
            if (r === 7 && done) finalDone = true;
          }
        }
      }
    }
    out.push(found ? { map: res, complete: finalDone || today > b } : null);
  }
  if (!out.some(Boolean)) { log('Tennis: no Slams for this season underway yet.'); return null; }
  return out;
}

/* ---------- today's games (backup for the site's Games tab) ---------- */
async function fetchScoreboards(ids = Object.keys(LEAGUES)) {
  const d = new Date(NOW.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const out = { at: NOW.toISOString() };
  for (const [id, L] of Object.entries(LEAGUES).filter(([id]) => ids.includes(id))) {
    try {
      const j = await getJSON(`${ESPN}/site/v2/sports/${L.path}/scoreboard?dates=${date}`, id + '-today');
      const events = (j?.events || []).map(ev => {
        const c = ev.competitions?.[0] || {}, st = c.status || ev.status || {};
        const side = k => { const x = (c.competitors || []).find(t => t.homeAway === k) || {}; return { name: x.team?.displayName || '', logo: x.team?.logo || '', score: x.score ?? '', winner: !!x.winner }; };
        return { id: ev.id, date: ev.date, state: st.type?.state || 'pre', detail: st.type?.shortDetail || '', note: c.notes?.[0]?.headline || '', away: side('away'), home: side('home') };
      });
      out[id] = { date, events };
    } catch (e) { log(`${L.label} games: ${e.message}`); }
  }
  return out;
}

/* ---------- team logos ---------- */
// ESPN's team lists include logos even before a season starts. Prefer the version made for dark backgrounds.
async function fetchLogos() {
  const out = {};
  for (const [id, L] of Object.entries(LEAGUES)) {
    try {
      const j = await getJSON(`${ESPN}/site/v2/sports/${L.path}/teams?limit=100`, id + '-teams');
      const teams = j?.sports?.[0]?.leagues?.[0]?.teams || [];
      const m = {};
      for (const t of teams) {
        const tm = t.team || t, logos = tm.logos || [];
        const pick = logos.find(l => (l.rel || []).includes('dark')) || logos.find(l => (l.rel || []).includes('default')) || logos[0];
        if (tm.displayName && pick?.href) m[tm.displayName] = pick.href;
      }
      if (Object.keys(m).length) out[id] = m;
    } catch (e) { log(`${L.label} logos: ${e.message}`); }
  }
  return out;
}

/* ---------- matching drafted names to feed names ---------- */
function matchName(names, pickName) {
  const p = slug(pickName), list = [...names];
  return list.find(n => slug(n) === p)
    || list.find(n => slug(n).endsWith('-' + p) || p.endsWith('-' + slug(n)))
    || (() => { const h = list.filter(n => slug(n).includes(p) || p.includes(slug(n))); return h.length === 1 ? h[0] : null; })()
    || (() => { const last = p.split('-').pop(); const h = list.filter(n => slug(n).split('-').pop() === last); return h.length === 1 ? h[0] : null; })();
}
const FIELDS = ['w', 'l', 'x', 'pos', 'pts', 'stage', 'res'];
const differs = (a, b) => a?.team !== b?.team || FIELDS.some(k => k in a && JSON.stringify(a[k] ?? null) !== JSON.stringify(b?.[k] ?? null));

async function main() {
  let db = null;
  if (!DRY) {
    const admin = (await import('firebase-admin')).default;
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT secret is missing. Add it under GitHub → Settings → Secrets and variables → Actions.');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
    db = admin.firestore();
  }
  const allPicks = db ? (await db.collection('picks').get()).docs.map(d => d.data()) : JSON.parse(process.env.GG_PICKS || '[]');
  const configs = {};
  if (db) (await db.collection('config').get()).docs.forEach(d => { configs[d.id] = d.data(); });
  else Object.assign(configs, JSON.parse(process.env.GG_CONFIG || '{}'));
  const current = Math.max(1, Number(configs.main?.current) || 1);
  // Score the current season and the one before it while it's still finishing (two weeks of slack after June 20).
  const endPlus = k => { const d = new Date(`${seasonEnd(k).slice(0, 4)}-${seasonEnd(k).slice(4, 6)}-${seasonEnd(k).slice(6)}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 14); return ymd(d); };
  let active = [current - 1, current].filter(k => k >= 1 && today <= endPlus(k));
  if (!active.length) active = [current];
  const existing = new Map();
  if (db) (await db.collection('results').get()).docs.forEach(d => existing.set(d.id, d.data()));

  const writes = [], updated = [], problems = [], usedLeagues = new Set();
  const guard = async (label, fn) => { try { return await fn(); } catch (e) { log(`${label}: ${e.message}`); problems.push(`${label} feed down`); return null; } };
  const DEFAULT_ON = { nfl: true, nba: true, nhl: true, epl: true, tennis: true }; // season 1's original lineup

  for (const k of active) {
  seasons = yearsFor(k);
  const P = prefix(k), tag = active.length > 1 ? `S${k} ` : '';
  const cfg = configs[k === 1 ? 'main' : `s${k}`] || {};
  const picks = allPicks.filter(p => (p.season || 1) === k);
  const on = cfg.sportsOn || (k === 1 ? DEFAULT_ON : { nfl: 1, nba: 1, nhl: 1, mlb: 1, epl: 1, f1: 1, golf: 1, tennis: 1 });
  const wanted = sp => !!on[sp] || picks.some(p => p.sport === sp);
  console.log(`Season ${k}${k === 1 ? '' : ` (years from ${2025 + k})`}: ${['nfl', 'nba', 'nhl', 'mlb', 'epl', 'f1', 'golf', 'tennis'].filter(wanted).join(', ')}`);
  const put = (id, fields) => {
    const full = P + id, old = existing.get(full);
    if (old?.manual) for (const key of ['stage', 'pos', 'res']) if (key in fields && (key !== 'pos' || fields.sport === 'golf')) delete fields[key];
    if (differs(fields, old)) writes.push(['results/' + full, fields]);
  };

  // Team leagues + F1
  for (const sport of [...Object.keys(LEAGUES), 'f1'].filter(wanted)) {
    if (LEAGUES[sport]) usedLeagues.add(sport);
    const label = tag + (LEAGUES[sport]?.label || 'F1');
    const data = await guard(label, () => sport === 'f1' ? fetchF1() : fetchLeague(sport));
    if (!data) continue;
    const post = sport !== 'f1' && LEAGUES[sport].post ? await guard(label + ' playoffs', () => fetchPlayoffs(sport)) : null;
    const docs = new Map();
    for (const r of data.rows) {
      const f = { sport, team: r.team, w: r.w ?? null, l: r.l ?? null, x: r.x ?? null, pos: r.pos ?? null, pts: r.pts ?? null, feed: true };
      if (post) f.stage = post.stage.get(r.team) ?? 0;
      docs.set(rid(sport, r.team), f);
    }
    const best = new Set(data.best), worst = new Set(data.worst || []);
    for (const p of picks.filter(p => p.sport === sport)) {
      const id = rid(sport, p.team); if (docs.has(id)) continue;
      const hit = matchName(data.rows.map(r => r.team), p.team);
      if (!hit) { problems.push(`no match for ${p.team}`); continue; }
      docs.set(id, { ...docs.get(rid(sport, hit)), team: p.team, feed: false });
      if (best.has(hit)) best.add(p.team);
      if (worst.has(hit)) worst.add(p.team);
    }
    for (const [id, f] of docs) put(id, f);
    writes.push(['meta/' + P + sport, { best: [...best], worst: [...worst], teams: data.rows.length, season: seasons[sport], done: !!(data.done || (post && post.stage.size)), ...(sport === 'f1' ? { round: data.round, total: data.total } : {}) }]);
    updated.push(label);
    const champ = post ? [...post.stage].filter(([, s]) => s === 5).map(([t]) => t)[0] : null;
    log(`${label}: ${data.rows.length} rows, best: ${[...best].join(' / ') || '—'}, season over: ${data.done ? 'yes' : 'no'}${post ? `, ${post.stage.size} playoff teams${champ ? ', champion ' + champ : ''}` : ''}`);
  }

  // Golf
  const golf = wanted('golf') ? await guard(tag + 'Golf', fetchGolf) : null;
  if (golf) {
    for (const p of picks.filter(p => p.sport === 'golf')) {
      const id = rid('golf', p.team), pos = [...(existing.get(P + id)?.pos || ['', '', '', ''])];
      golf.forEach((m, i) => { if (!m) return; const hit = matchName(m.map.keys(), p.team); pos[i] = hit ? m.map.get(hit) : 'MC'; if (!hit) log(`Golf: ${p.team} not in the ${m.name} field (counted as missed cut).`); });
      put(id, { sport: 'golf', team: p.team, pos });
    }
    writes.push(['meta/' + P + 'golf', { field: golf.map(m => m?.field || null), season: seasons.golf }]);
    updated.push(tag + 'Golf');
  }

  // Tennis
  const tennis = wanted('tennis') ? await guard(tag + 'Tennis', fetchTennis) : null;
  if (tennis) {
    for (const p of picks.filter(p => p.sport === 'tennis')) {
      const id = rid('tennis', p.team), res = [...(existing.get(P + id)?.res || ['', '', '', ''])];
      tennis.forEach((s, i) => {
        if (!s) return;
        const hit = matchName(s.map.keys(), p.team);
        if (hit) res[i] = s.map.get(hit);
        else if (s.complete) { res[i] = 'WD'; log(`Tennis: ${p.team} not found in Slam ${i + 1} (counted as withdrew).`); }
      });
      put(id, { sport: 'tennis', team: p.team, res });
    }
    updated.push(tag + 'Tennis');
  }

  // Last season's results, used by the site to project this season during the draft
  const prev = {};
  for (const sport of Object.keys(LEAGUES).filter(wanted)) {
    const L = LEAGUES[sport];
    const d = await guard(tag + L.label + ' last season', () => fetchLeague(sport, seasons[sport] - 1));
    if (!d) continue;
    prev[sport] = Object.fromEntries(d.rows.map(r => { const gp = r.w + r.l + r.x; return [r.team, gp ? +((r.w + (L.xw || 0) * r.x) / gp).toFixed(4) : 0.5]; }));
  }
  const f1prev = wanted('f1') ? await guard(tag + 'F1 last season', () => fetchF1(seasons.f1 - 1)) : null;
  if (f1prev) { const N = f1prev.rows.length; prev.f1 = Object.fromEntries(f1prev.rows.map(r => [r.team, N > 1 && r.pos ? +((N - r.pos) / (N - 1)).toFixed(4) : 0.5])); }
  if (Object.keys(prev).length) { writes.push(['meta/' + P + 'prev', prev]); log(`${tag}Last season: ${Object.entries(prev).map(([k, v]) => `${k} ${Object.keys(v).length}`).join(', ')}`); }

  } // end of season loop

  // Today's games
  const boards = await guard('Games', () => fetchScoreboards([...usedLeagues]));
  if (boards) { writes.push(['meta/scoreboard', boards]); log(`Games today: ${Object.entries(boards).filter(([k]) => k !== 'at').map(([k, v]) => `${k} ${v.events.length}`).join(', ')}`); }

  // Logos
  const logos = await guard('Logos', fetchLogos);
  if (logos && Object.keys(logos).length) { writes.push(['meta/logos', logos]); log(`Logos: ${Object.entries(logos).map(([k, v]) => `${k} ${Object.keys(v).length}`).join(', ')}`); }

  const note = (updated.length ? updated.join(', ') + ' updated' : 'No seasons in progress') + (problems.length ? ' · ' + problems.slice(0, 3).join(', ') : '');
  writes.push(['sync/main', { at: NOW.toISOString(), note: note.slice(0, 120) }]);
  if (DRY) { console.log(`Dry run: would write ${writes.length} documents. Note: "${note}"`); for (const [p, f] of writes) if (/stage|pos|res/.test(JSON.stringify(f)) && p.startsWith('results/') && (f.stage || f.res || Array.isArray(f.pos))) console.log('   ', p, JSON.stringify(f.stage ?? f.res ?? f.pos)); return; }
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch();
    for (const [path, fields] of writes.slice(i, i + 400)) batch.set(db.doc(path), fields, { merge: true });
    await batch.commit();
  }
  console.log(`Wrote ${writes.length} documents. ${note}`);
}

main().catch(e => { console.error(e); process.exit(1); });
