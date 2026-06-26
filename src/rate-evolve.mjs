// PHASE B — evolving skill rating WITHOUT pairings.
// Anchors on the frozen Glicko base (rate.mjs output from real matches) and
// EVOLVES it with placement-percentile nudges over events that have placements
// but NO pairings (the registration-only events, incl. everything post the
// 2026-06 UVS pairings lockdown). New players (no frozen base) seed provisional.
//
// Validated by backtest (anchor+evolve K=32 -> Spearman 0.98 vs exact ratings,
// top-100 overlap 82%, movement-vs-reality corr 0.67). REVERSIBLE: writes new
// columns rating_evo / rd_evo / games_evo; never overwrites the frozen `rating`.
//
//   DB_PATH=... node src/rate-evolve.mjs

import { db } from "./db.mjs";

const K = Number(process.env.EVO_K || 32);
const CAP = Number(process.env.EVO_CAP || 60);      // max |delta| per event
const SEED = 1500, SEED_RD = 350, RD_FLOOR = 60, RD_STEP = 0.97;
const EXP = (ra, rb) => 1 / (1 + Math.pow(10, (rb - ra) / 400));

// reversible columns
for (const col of ["rating_evo REAL", "rd_evo REAL", "games_evo INTEGER"]) {
  try { db.exec(`ALTER TABLE ratings ADD COLUMN ${col}`); } catch {}
}

// frozen base
const base = new Map();   // id -> {r, rd, g}
for (const r of db.prepare("SELECT player_id id, rating, rd, games FROM ratings WHERE rating IS NOT NULL").all())
  base.set(String(r.id), { r: r.rating, rd: r.rd ?? 120, g: r.games ?? 0 });

// events with placements but NO matches (the un-paired / post-lockdown corpus)
const withMatches = new Set(db.prepare("SELECT DISTINCT event_id e FROM matches").all().map(r => r.e));
const rows = db.prepare(`SELECT p.event_id eid, CAST(p.player_id AS TEXT) pid, p.rank, e.date
  FROM placements p JOIN events e ON e.id=p.event_id
  WHERE e.date IS NOT NULL AND p.rank IS NOT NULL
  ORDER BY e.date ASC, p.event_id ASC, p.rank ASC`).all();

const est = new Map();    // id -> {r, rd, g}
const get = (id) => est.get(id) || (base.has(id) ? { ...base.get(id) } : { r: SEED, rd: SEED_RD, g: 0 });
const sample = (n, m, seed) => { if (n <= m) return null; const o = []; let s = seed % n, st = Math.max(1, (n / m) | 0); for (let c = 0; c < m; c++) { o.push(s); s = (s + st + 1) % n; } return o; };

let evoEvents = 0;
let i = 0;
while (i < rows.length) {
  const eid = rows[i].eid; const g = [];
  while (i < rows.length && rows[i].eid === eid) g.push(rows[i++]);
  if (withMatches.has(eid)) continue;     // exact-rated already by rate.mjs -> skip
  if (g.length < 2) continue;
  evoEvents++;
  const N = g.length, ups = [];
  for (let j = 0; j < N; j++) {
    const p = g[j], me = get(p.pid), S = (N - 1 - j) / (N - 1);
    const idx = sample(N, 80, eid >>> 0); let s = 0, n = 0;
    if (idx) { for (const k of idx) { if (k === j) continue; s += EXP(me.r, get(g[k].pid).r); n++; } }
    else { for (let k = 0; k < N; k++) { if (k === j) continue; s += EXP(me.r, get(g[k].pid).r); n++; } }
    let d = K * (S - (n ? s / n : 0.5));
    d = Math.max(-CAP, Math.min(CAP, d));
    ups.push([p.pid, d]);
  }
  for (const [pid, d] of ups) { const c = get(pid); est.set(pid, { r: c.r + d, rd: Math.max(RD_FLOOR, c.rd * RD_STEP), g: c.g + 1 }); }
}

// write rating_evo (= evolved where the player appeared in evo events, else frozen base)
const upd = db.prepare("UPDATE ratings SET rating_evo=?, rd_evo=?, games_evo=? WHERE player_id=?");
db.exec("BEGIN");
let moved = 0;
for (const [id, b] of base) {
  const e = est.get(id);
  if (e) { upd.run(Math.round(e.r), Math.round(e.rd), e.g, id); if (Math.abs(e.r - b.r) >= 1) moved++; }
  else { upd.run(b.r, Math.round(b.rd), b.g, id); }   // unchanged base
}
// brand-new players (no frozen base) that appeared in evo events
const insNew = db.prepare("INSERT OR IGNORE INTO ratings(player_id, rating, rd, games, provisional, rating_evo, rd_evo, games_evo) VALUES(?,?,?,?,1,?,?,?)");
let newP = 0;
for (const [id, e] of est) {
  if (base.has(id)) continue;
  insNew.run(id, Math.round(e.r), Math.round(e.rd), e.g, Math.round(e.r), Math.round(e.rd), e.g);
  upd.run(Math.round(e.r), Math.round(e.rd), e.g, id);
  newP++;
}
db.exec("COMMIT");

console.log(`Phase B: evolved over ${evoEvents} placement-only events. base players ${base.size}, moved ${moved}, new players ${newP}.`);
