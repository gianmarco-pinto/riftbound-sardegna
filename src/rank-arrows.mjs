// Post-build step: inject position-movement deltas into the built leaderboard
// shards. Runs AFTER build-site, BEFORE publish. Does NOT touch build-site.
//
// Two deltas per leaderboard shard (the board renders both views from it):
//   rankDelta     = change in the RATING rank (ranked, non-provisional rows)
//   raceRankDelta = change in the CIRCUIT rank (race.points>0, frontend's sort)
// Positive = moved up. Semantics: movement since the START of the current ISO
// week (baseline snapshot in data/rank-history.json, persisted in state release,
// rotated on the first run of each new week).
//
//   node src/rank-arrows.mjs   (SITE_DIR=site)

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const SITE = process.env.SITE_DIR || "site";
const HIST = "data/rank-history.json";

function isoWeek(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

let hist = {}; try { hist = JSON.parse(readFileSync(HIST, "utf8")); } catch {}
const week = process.env.WEEK_OVERRIDE || isoWeek();
const sameWeek = hist.week === week;
const next = { week, r: {}, c: {} };
let injected = 0;

const lbDir = join(SITE, "leaderboards");
if (existsSync(lbDir)) for (const f of readdirSync(lbDir)) {
  if (!f.endsWith(".json") || f === "index.json" || f === "search.json") continue;
  const scope = f.replace(/\.json$/, ""); const path = join(lbDir, f);
  let shard; try { shard = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
  if (!Array.isArray(shard.players)) continue;
  const prevR = sameWeek ? (hist.r?.[scope] || {}) : {};
  const prevC = sameWeek ? (hist.c?.[scope] || {}) : {};
  next.r[scope] = {}; next.c[scope] = {};

  // RATING rank: ranked rows only (rated, non-provisional) — matches the board.
  let rr = 0;
  for (const p of shard.players) {
    if (p.rated === false || p.provisional) { delete p.rankDelta; continue; }
    rr++; next.r[scope][p.id] = rr;
    if (prevR[p.id] != null) { p.rankDelta = prevR[p.id] - rr; injected++; } else delete p.rankDelta;
  }
  // CIRCUIT rank: race.points>0, sorted exactly like the frontend.
  const race = shard.players.filter((p) => (p.race?.points ?? 0) > 0)
    .sort((a, b) => (b.race.points - a.race.points) || (b.race.first - a.race.first) || a.handle.localeCompare(b.handle));
  let cr = 0;
  for (const p of shard.players) delete p.raceRankDelta;
  for (const p of race) { cr++; next.c[scope][p.id] = cr;
    if (prevC[p.id] != null) { p.raceRankDelta = prevC[p.id] - cr; injected++; } }

  writeFileSync(path, JSON.stringify(shard));
}

if (!sameWeek) writeFileSync(HIST, JSON.stringify(next));
console.log(`rank-arrows: week ${week} (${sameWeek ? "within-week" : "new week -> baseline rotated"}), deltas injected on ${injected} rows.`);
