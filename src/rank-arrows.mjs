// Post-build step: inject prevRank into the already-built leaderboard & circuit
// shards, by comparing current positions to a weekly snapshot. Runs AFTER
// build-site, BEFORE publish. Does NOT touch build-site (low risk).
//
// Semantics: "movement since the start of the current ISO week". A baseline
// snapshot is captured on the first run of each ISO week (data/rank-history.json,
// persisted in the state release). Within the week, prevRank = the week-start
// position, so the frontend shows ▲/▼ vs the start of this week.
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
const sameWeek = hist.week === week;            // within-week run -> compare to baseline
const next = { week, r: {}, c: {} };            // new baseline (rebuilt every run; saved when week rolls)
let injected = 0;

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// --- RATING boards: site/leaderboards/<scope>.json (rows sorted by rating; rank among rated) ---
const lbDir = join(SITE, "leaderboards");
if (existsSync(lbDir)) for (const f of readdirSync(lbDir)) {
  if (!f.endsWith(".json") || f === "index.json" || f === "search.json") continue;
  const scope = f.replace(/\.json$/, ""); const path = join(lbDir, f);
  let shard; try { shard = readJson(path); } catch { continue; }
  if (!Array.isArray(shard.players)) continue;
  next.r[scope] = {}; const prev = sameWeek ? (hist.r?.[scope] || {}) : {};
  let rank = 0;
  for (const p of shard.players) {
    // canonical Rating rank = ranked rows only (rated, non-provisional) — matches
    // the board's numbering and is filter-independent, so the delta is unambiguous.
    if (p.rated === false || p.provisional) { delete p.rankDelta; continue; }
    rank++; next.r[scope][p.id] = rank;
    if (prev[p.id] != null) { p.rankDelta = prev[p.id] - rank; injected++; } else delete p.rankDelta; // + = moved up
  }
  writeFileSync(path, JSON.stringify(shard));
}

// --- CIRCUIT boards: site/circuit/<scope>/current.json (rows sorted by points) ---
const cDir = join(SITE, "circuit");
if (existsSync(cDir)) for (const scope of readdirSync(cDir)) {
  const cur = join(cDir, scope, "current.json");
  if (!existsSync(cur)) continue;
  let shard; try { shard = readJson(cur); } catch { continue; }
  if (!Array.isArray(shard.players)) continue;
  next.c[scope] = {}; const prev = sameWeek ? (hist.c?.[scope] || {}) : {};
  let rank = 0;
  for (const p of shard.players) { rank++; next.c[scope][p.id] = rank;
    if (prev[p.id] != null) { p.rankDelta = prev[p.id] - rank; injected++; } else delete p.rankDelta; }
  writeFileSync(cur, JSON.stringify(shard));
}

// rotate baseline: only overwrite the saved snapshot when a NEW week begins (so the
// week-start positions stay fixed all week). First run ever also seeds it.
if (!sameWeek) writeFileSync(HIST, JSON.stringify(next));
console.log(`rank-arrows: week ${week} (${sameWeek ? "within-week" : "new week -> baseline rotated"}), prevRank injected on ${injected} rows.`);
