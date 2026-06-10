// Generate the static site's data file (site/data.json) from SQLite.
// The HTML/JS in site/ are static and version-controlled; only data.json is
// regenerated on each ingest. Deploy the whole site/ folder to Vercel/Netlify.
//
// Privacy: only handles are emitted (no email/real name — those never entered
// the DB in the first place).
//
// Usage:  node src/build-site.mjs

import { db } from "./db.mjs";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";

// Nickname sources (id -> nickname), no real names published:
//  1. nicknames.json            — manual / opt-in overrides (committed)
//  2. data/nicknames-resolved.json — auto-resolved from account histories
//     (see resolve-nicknames.mjs; the global, accumulating source)
//  3. fallback: initials of the real name (never the full name)
let MANUAL = {}, RESOLVED = {};
try { MANUAL = JSON.parse(readFileSync("nicknames.json", "utf8")); } catch {}
try { RESOLVED = JSON.parse(readFileSync("data/nicknames-resolved.json", "utf8")); } catch {}

function initials(name) {
  if (!name) return "Anonimo";
  if (/^User\d+$/i.test(name) || name === "Unknown") return "Anonimo";
  return name.trim().split(/\s+/).filter(Boolean).map((p) => p[0].toUpperCase() + ".").join(" ");
}
const handleOf = (realName, id) => MANUAL[String(id)] || RESOLVED[String(id)] || initials(realName);

// --- tournament tier classification (by event name) ---
// Hierarchy (least -> most important): 1 Pre-Rift, 2 Nexus Night, 3 Skirmish,
// 4 Regional Qualifier, 5 Regional. Rules agreed with the league:
//  - any "Release" event counts as Pre-Rift
//  - anything containing "Nexus" is a Nexus Night, whatever follows
// Checks go from most to least prestigious so combined names resolve upward.
const TIERS = { 1: "Pre-Rift", 2: "Nexus Night", 3: "Skirmish", 4: "Regional Qualifier", 5: "Regional" };
function classifyTier(name) {
  const n = name || "";
  if (/qualifier/i.test(n)) return 4;
  if (/regional/i.test(n)) return 5;
  if (/skirmish/i.test(n)) return 3;
  if (/nexus/i.test(n)) return 2;
  if (/pre.?rift|release/i.test(n)) return 1;
  return null; // unclassified: counts for rating, not for palmares
}

// --- final placements (from v2 standings, see resolve-nicknames.mjs) ---
let PLACEMENTS = {};
try { PLACEMENTS = JSON.parse(readFileSync("data/placements.json", "utf8")); } catch {}

// --- events (with store + geo) ---
const eventsRows = db.prepare(`
  SELECT e.id, e.name, e.date, e.region, e.city, e.country, s.name AS store
  FROM events e LEFT JOIN stores s ON s.id = e.store_id`).all();
const events = {};
for (const e of eventsRows) {
  const tier = classifyTier(e.name);
  events[e.id] = { ...e, tier, tierLabel: tier ? TIERS[tier] : null };
}

// playerId -> { tier -> {first, second, third} }
const palmaresOf = new Map();
const unclassified = new Set();
for (const [eid, info] of Object.entries(PLACEMENTS)) {
  const ev = events[eid];
  if (!ev) continue;
  if (!ev.tier) { if (ev.name) unclassified.add(ev.name); continue; }
  for (const [pid, rank] of Object.entries(info.places || {})) {
    if (rank > 3) continue;
    let byTier = palmaresOf.get(pid);
    if (!byTier) { byTier = new Map(); palmaresOf.set(pid, byTier); }
    let t = byTier.get(ev.tier);
    if (!t) { t = { first: 0, second: 0, third: 0 }; byTier.set(ev.tier, t); }
    if (rank === 1) t.first++;
    else if (rank === 2) t.second++;
    else t.third++;
  }
}
if (unclassified.size) {
  console.warn(`Unclassified event names (no tier, excluded from palmares): ${[...unclassified].slice(0, 8).join(" | ")}`);
}

// --- snapshots: opponent-rating-at-event lookup + per-player series ---
const snaps = db.prepare(`SELECT player_id, event_id, date, rating, rd FROM rating_snapshots`).all();
const snapAt = new Map();              // `${pid}:${eid}` -> rating
const seriesOf = new Map();            // pid -> [{date, rating, rd, eventId, eventName}]
for (const s of snaps) {
  snapAt.set(`${s.player_id}:${s.event_id}`, s.rating);
  if (!seriesOf.has(s.player_id)) seriesOf.set(s.player_id, []);
  seriesOf.get(s.player_id).push({
    date: s.date, rating: s.rating, rd: s.rd,
    eventId: s.event_id, eventName: events[s.event_id]?.name || "",
  });
}
for (const arr of seriesOf.values()) arr.sort((a, b) => String(a.date).localeCompare(String(b.date)));

// --- matches (decided, non-bye) ---
const matchRows = db.prepare(`
  SELECT id, event_id AS eventId, date, player_a AS a, player_b AS b, winner
  FROM matches
  WHERE is_bye = 0 AND winner IS NOT NULL AND player_a IS NOT NULL AND player_b IS NOT NULL
  ORDER BY date ASC`).all();

// --- players + ratings ---
const ratingRows = db.prepare(`
  SELECT r.player_id AS id, p.handle, r.rating, r.rd, r.vol,
         r.games, r.wins, r.losses, r.draws, r.provisional, r.last_date AS lastDate
  FROM ratings r JOIN players p ON p.id = r.player_id`).all();

const ratingMap = new Map(ratingRows.map((r) => [r.id, r]));

// regions each player has played in
const playerRegions = new Map();
const addRegion = (pid, reg) => {
  if (!reg) return;
  if (!playerRegions.has(pid)) playerRegions.set(pid, new Set());
  playerRegions.get(pid).add(reg);
};
for (const m of matchRows) {
  const reg = events[m.eventId]?.region;
  addRegion(m.a, reg); addRegion(m.b, reg);
}

const players = ratingRows.map((p) => {
  // best win / worst loss measured by opponent's rating AT that event
  let bestWin = null, worstLoss = null;
  for (const m of matchRows) {
    if (m.a !== p.id && m.b !== p.id) continue;
    const meA = m.a === p.id;
    const oppId = meA ? m.b : m.a;
    const won = (m.winner === "A" && meA) || (m.winner === "B" && !meA);
    const lost = (m.winner === "A" && !meA) || (m.winner === "B" && meA);
    const oppRating = snapAt.get(`${oppId}:${m.eventId}`);
    if (oppRating == null) continue;
    const oppHandle = handleOf(ratingMap.get(oppId)?.handle, oppId);
    const rec = { oppId, oppHandle, oppRating, eventName: events[m.eventId]?.name || "", date: m.date };
    if (won && (!bestWin || oppRating > bestWin.oppRating)) bestWin = rec;
    if (lost && (!worstLoss || oppRating < worstLoss.oppRating)) worstLoss = rec;
  }
  return {
    id: p.id,
    handle: handleOf(p.handle, p.id),
    rating: p.rating, rd: p.rd, vol: p.vol,
    games: p.games, wins: p.wins, losses: p.losses, draws: p.draws,
    provisional: !!p.provisional, lastDate: p.lastDate,
    regions: [...(playerRegions.get(p.id) || [])],
    series: seriesOf.get(p.id) || [],
    bestWin, worstLoss,
    // podiums per tier, most prestigious first: [{tier, label, first, second, third}]
    palmares: [...(palmaresOf.get(String(p.id)) || new Map())]
      .sort((a, b) => b[0] - a[0])
      .map(([tier, c]) => ({ tier, label: TIERS[tier], ...c })),
  };
});

players.sort((a, b) => b.rating - a.rating);

const regions = [...new Set(eventsRows.map((e) => e.region).filter(Boolean))].sort();

const out = {
  generatedAt: new Date().toISOString(),
  counts: { players: players.length, matches: matchRows.length, events: eventsRows.length },
  regions,
  events,
  players,
  matches: matchRows, // compact: {id,eventId,date,a,b,winner} — client derives H2H
};

mkdirSync("site", { recursive: true });
writeFileSync("site/data.json", JSON.stringify(out));
console.log(`Wrote site/data.json — ${players.length} players, ${matchRows.length} matches, ${regions.length} regions.`);
