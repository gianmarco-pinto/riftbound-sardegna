// Generate the website data from SQLite — SHARDED for worldwide scale:
//
//   site/data.json                  legacy single-file dataset, SARDEGNA-scoped
//                                   (keeps the currently-deployed page working)
//   site/leaderboards/index.json    available scopes (countries/continents)
//   site/leaderboards/<scope>.json  light ranking rows per scope:
//                                   global, sardegna, country (it, fr...),
//                                   continent (eu, am, as, oc, af)
//   site/players/<id>.json          full profile per player (series, palmares,
//                                   race, matches) — loaded on click
//
// A player belongs to a scope if they played >=1 match there. Ratings are
// GLOBAL (one per player); scopes are views. Only nicknames/initials emitted.
//
// Usage:  node src/build-site.mjs

import { db, allPlacements } from "./db.mjs";
import { CONTINENT_LABELS, continentOf, ORGANIZER_STORE_IDS } from "./scopes.mjs";
import { writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";

// --- display identity (nickname || initials; never real names) ---
let MANUAL = {}, RESOLVED = {};
try { MANUAL = JSON.parse(readFileSync("nicknames.json", "utf8")); } catch {}
try { RESOLVED = JSON.parse(readFileSync("data/nicknames-resolved.json", "utf8")); } catch {}

// GDPR opt-out: player ids listed in excluded.json are anonymized everywhere
// ("Anonimo", no profile shard, no leaderboard rows). Their matches stay in the
// rating math (removing them would corrupt opponents' ratings) but nothing
// identifying is published.
let EXCLUDED = new Set();
try { EXCLUDED = new Set(JSON.parse(readFileSync("excluded.json", "utf8")).map(String)); } catch {}

function initials(name) {
  if (!name) return "Anonimo";
  if (/^User\d+$/i.test(name) || name === "Unknown") return "Anonimo";
  return name.trim().split(/\s+/).filter(Boolean).map((p) => p[0].toUpperCase() + ".").join(" ");
}
const handleOf = (realName, id) =>
  EXCLUDED.has(String(id)) ? "Anonimo" : (MANUAL[String(id)] || RESOLVED[String(id)] || initials(realName));

// --- tournament tiers ---
const TIERS = { 1: "Pre-Rift", 2: "Nexus Night", 3: "Skirmish", 4: "Regional Qualifier", 5: "Regional Championship" };
const OFFICIAL_STORES = new Set(ORGANIZER_STORE_IDS);
// Regional Qualifier (4) and Regional Championship (5) are DISTINCT and exist
// ONLY as official UVS main events — matched by exact phrase AND official store.
// This excludes the swarm of look-alikes (store "Regional Qualifier
// Celebration", "Pre-Regional Challenge", "Regional Rebound", "PPG Qualifier",
// side-events like "Team Trios Sealed - RQ Bologna"), which fall through to the
// local tiers. Everything outside the nomenclature counts as a Nexus Night.
function classifyTier(name, official) {
  const n = name || "";
  if (official) {
    if (/regional championship/i.test(n)) return 5;
    if (/regional qualifier/i.test(n)) return 4;
  }
  // Only the official "Summoner Skirmish" is the premier local tier; generic
  // "<store> Skirmish" look-alikes (~1.2k) fall through to Nexus.
  if (/summoner skirmish/i.test(n)) return 3;
  if (/nexus/i.test(n)) return 2;
  if (/pre.?rift|release/i.test(n)) return 1;
  return 2;
}

// --- load core data ---
const eventsRows = db.prepare(`
  SELECT e.id, e.name, e.date, e.region, e.city, e.country, e.continent, e.store_id, s.name AS store
  FROM events e LEFT JOIN stores s ON s.id = e.store_id`).all();
const events = {};
for (const e of eventsRows) {
  const tier = classifyTier(e.name, OFFICIAL_STORES.has(e.store_id));
  events[e.id] = { ...e, tier, tierLabel: tier ? TIERS[tier] : null };
}

const matchRows = db.prepare(`
  SELECT id, event_id AS eventId, date, player_a AS a, player_b AS b, winner,
         games_a AS ga, games_b AS gb
  FROM matches
  WHERE is_bye = 0 AND winner IS NOT NULL AND player_a IS NOT NULL AND player_b IS NOT NULL
  ORDER BY date ASC`).all();

const snaps = db.prepare(`SELECT player_id, event_id, date, rating, rd FROM rating_snapshots`).all();
const snapAt = new Map();
const seriesOf = new Map();
for (const s of snaps) {
  snapAt.set(`${s.player_id}:${s.event_id}`, s.rating);
  if (!seriesOf.has(s.player_id)) seriesOf.set(s.player_id, []);
  seriesOf.get(s.player_id).push({
    date: s.date, rating: s.rating, rd: s.rd,
    eventId: s.event_id, eventName: events[s.event_id]?.name || "",
  });
}
for (const arr of seriesOf.values()) arr.sort((a, b) => String(a.date).localeCompare(String(b.date)));
// rdeltaOf (per-event rating change) is computed later, once event tiers/field
// sizes are known — see "per-event RATING change" below. Glicko runs in WEEKLY
// periods, so every event in the same week shares one snapshot rating; we must
// attribute that week's change to the week's FLAGSHIP event, not split per row.

// Phase B: prefer the EVOLVING rating (rate-evolve.mjs: frozen Glicko base +
// placement nudges over un-paired/post-lockdown events). Falls back to the frozen
// `rating` if rate-evolve hasn't run yet (rating_evo NULL) — so this is safe/reversible.
const ratingRows = db.prepare(`
  SELECT r.player_id AS id, p.handle,
         COALESCE(r.rating_evo, r.rating) AS rating,
         COALESCE(r.rd_evo, r.rd) AS rd, r.vol,
         COALESCE(r.games_evo, r.games) AS games, r.wins, r.losses, r.draws, r.provisional, r.last_date AS lastDate
  FROM ratings r JOIN players p ON p.id = r.player_id`).all();
const ratingMap = new Map(ratingRows.map((r) => [r.id, r]));

// --- placements -> palmares + race ---
const PLACEMENTS = {};
for (const p of allPlacements()) {
  (PLACEMENTS[p.eventId] ||= { participants: p.participants, places: {} }).places[p.playerId] = p.rank;
}
const palmaresOf = new Map();
const majorsOf = new Map(); // pid -> [{eventName, date, tier, label, rank, participants}] for tier>=4
// Race scoring is driven by FIELD SIZE (participants), not tier: tier names are
// unreliable worldwide (typos, many languages) and big "off-nomenclature" events
// exist (e.g. an 860-player RQ side event would otherwise count as a tiny Nexus).
// Official RQ/Regional get a prestige bonus on top; tier is still used for the
// palmares/medals, where the exact official name matters.
// Circuit points (council-redesigned 2026-06-21): reward DEPTH of finish, NOT field
// size. The old `fieldSize × placeFactor` paid for the denominator — mid/low finishes
// at big events outscored winning small ones (e.g. 500th/1000 ≈ 100-150 pts vs a
// 10-player win = 10). Now: a tier base, a gentle log size bonus that only raises the
// CEILING for good finishes, a placement BRACKET (mid/low = 0, no participation floor),
// and BEST-N aggregation (not sum) to stop volume/travel farming.
// CIRCUIT v2 — per-SET "Championship Race" (council + user, 2026-06-22). A season
// IS a card set (~3 months). Two tracks per set: LOCAL (Pre-Rift/Nexus) counts your
// best-LOCAL_BEST_N; PREMIER (Summoner Skirmish/RQ/Regional) counts your best-
// PREMIER_BEST_N and ONLY a top-cut "decent result" scores (no participation
// points). Reset every set → no staleness; the two best-N caps → no volume/travel
// farming. Set membership is by event date against the published set calendar.
const SET_DATES = [
  { id: "origins", name: "Origins", start: "2025-10-31" },
  { id: "spiritforged", name: "Spiritforged", start: "2026-02-13" },
  { id: "unleashed", name: "Unleashed", start: "2026-05-08" },
  { id: "vendetta", name: "Vendetta", start: "2026-07-31" },
];
const setStartMs = SET_DATES.map((s) => Date.parse(s.start));
const setOf = (date) => {
  const t = date ? Date.parse(date) : NaN;
  if (Number.isNaN(t)) return null;
  let id = null;
  for (let i = 0; i < SET_DATES.length; i++) if (t >= setStartMs[i]) id = SET_DATES[i].id; else break;
  return id; // before Set 1 → null (pre-season, not scored)
};
const NOW = Date.now();
const currentSetId = setOf(new Date(NOW).toISOString()) || SET_DATES[SET_DATES.length - 1].id;

// Premier bases RAISED so an RQ/Regional result dominates local Skirmish grinding:
// a 2-RQ champion (incl. a win) must outrank a 4-Skirmish farmer. RQ:Skirmish ≈ 4.3x.
const BASE = { 1: 18, 2: 20, 3: 30, 4: 130, 5: 230 };
const LOCAL_BEST_N = Number(process.env.LOCAL_BEST_N || 5);
const PREMIER_BEST_N = Number(process.env.PREMIER_BEST_N || 4);
const CUT_FRAC = Number(process.env.CUT_FRAC || 0.08);   // premier "decent result" = top ~8%
const CUT_FLOOR = Number(process.env.CUT_FLOOR || 4);
// Cap on how deep a premier cut goes. 128 mirrors the RQ prize cut (the top 128 at a
// Regional Qualifier are "in the prizes"), so big RQs award the prize-eligible field.
const MAX_CUT = Number(process.env.MAX_CUT || 128);
const MIN_PREMIER_FIELD = Number(process.env.MIN_PREMIER_FIELD || 16); // a "Summoner Skirmish" needs >=16 players to count as premier (tiny ones -> local)
const clampN = (lo, hi, x) => Math.max(lo, Math.min(hi, x));
const sizeMult = (n) => clampN(1.0, 1.5, 1 + Math.log10(Math.max(1, n)) / 5);
// a premier-tier event with too small a field is demoted to the local track.
const trackOf = (tier, n) => (tier >= 3 && n >= MIN_PREMIER_FIELD) ? "premier" : "local";
const capOf = (track, n) => track === "premier"
  ? clampN(CUT_FLOOR, MAX_CUT, Math.ceil(CUT_FRAC * n))
  : Math.max(8, Math.ceil(0.15 * n));
const placeCurve = (rank, cap) => rank <= cap ? Math.pow(1 - (rank - 1) / cap, 1.5) : 0;
const eventPoints = (rank, n, tier) => {
  const track = trackOf(tier, n);
  const effTier = (tier >= 3 && track === "local") ? 2 : tier; // demoted small premier scores as Nexus
  return Math.round((BASE[effTier] || 20) * sizeMult(n) * placeCurve(rank, capOf(track, n)));
};

const fieldSizeOf = new Map(); // eid -> deduped field size used for Circuit points
// raceBySet: pid -> Map(setId -> {premier:[{eid,pts}], local:[{eid,pts}], first,second,third, events})
const raceBySet = new Map();
const setBucket = (pid, setId) => {
  let m = raceBySet.get(pid); if (!m) { m = new Map(); raceBySet.set(pid, m); }
  let r = m.get(setId); if (!r) { r = { premier: [], local: [], first: 0, second: 0, third: 0, events: 0 }; m.set(setId, r); }
  return r;
};
for (const [eid, info] of Object.entries(PLACEMENTS)) {
  const ev = events[eid];
  if (!ev?.tier) continue;
  const fieldSize = Object.keys(info.places).length;
  fieldSizeOf.set(eid, fieldSize);
  const setId = setOf(ev.date);
  const track = trackOf(ev.tier, fieldSize);
  for (const [pid, rank] of Object.entries(info.places)) {
    if (rank <= 3) {
      let byTier = palmaresOf.get(pid);
      if (!byTier) { byTier = new Map(); palmaresOf.set(pid, byTier); }
      let t = byTier.get(ev.tier);
      if (!t) { t = { first: 0, second: 0, third: 0 }; byTier.set(ev.tier, t); }
      if (rank === 1) t.first++; else if (rank === 2) t.second++; else t.third++;
    }
    // Majors (Regional Qualifier / Regional): record the exact finish, podium
    // or not — finishing 32nd of 1719 at an RQ is a real achievement.
    if (ev.tier >= 4) {
      let arr = majorsOf.get(pid);
      if (!arr) { arr = []; majorsOf.set(pid, arr); }
      arr.push({ eventName: ev.name, date: ev.date, tier: ev.tier, label: ev.tierLabel, rank, participants: fieldSize });
    }
    if (setId) {
      const pts = eventPoints(rank, fieldSize, ev.tier);
      const r = setBucket(pid, setId);
      r.events++;
      if (rank === 1) r.first++; else if (rank === 2) r.second++; else if (rank === 3) r.third++;
      if (pts > 0) (track === "premier" ? r.premier : r.local).push({ eid, pts });
    }
  }
}
// Per (player, set): setScore = best-PREMIER_BEST_N premier + best-LOCAL_BEST_N local.
// raceSetOf: pid -> Map(setId -> {points, premierPts, localPts, events, first, second, third}).
// countedEidsOf: pid -> Set(eid) of events that contributed to ANY set's score (for the C badge).
const raceSetOf = new Map();
const countedEidsOf = new Map();
for (const [pid, m] of raceBySet) {
  const cm = new Map(); raceSetOf.set(pid, cm);
  const counted = new Set();
  for (const [setId, r] of m) {
    r.premier.sort((a, b) => b.pts - a.pts);
    r.local.sort((a, b) => b.pts - a.pts);
    const P = r.premier.slice(0, PREMIER_BEST_N), L = r.local.slice(0, LOCAL_BEST_N);
    const premierPts = P.reduce((s, x) => s + x.pts, 0), localPts = L.reduce((s, x) => s + x.pts, 0);
    cm.set(setId, { points: premierPts + localPts, premierPts, localPts, events: r.events, first: r.first, second: r.second, third: r.third });
    for (const x of P) counted.add(x.eid);
    for (const x of L) counted.add(x.eid);
  }
  countedEidsOf.set(pid, counted);
}
// Headline `race` = the CURRENT set's standing (keeps the existing per-scope board
// working; the dedicated per-set / all-time views read the circuit/* shards below).
const raceOf = new Map();
for (const [pid, cm] of raceSetOf) {
  const cur = cm.get(currentSetId);
  if (cur && cur.points > 0) raceOf.set(pid, { points: cur.points, events: cur.events, first: cur.first, second: cur.second, third: cur.third, premierPts: cur.premierPts, localPts: cur.localPts });
}

// --- per-player scopes + matches ---
// Nationality is the player's HOME country: the country where they played the
// most tournaments (tie-break: more matches, then most recent). A player shows
// ONLY in their home country + that continent + Global — visiting an event
// abroad no longer drops them into that country's board. Exception: anyone who
// has played in Sardinia also appears in Sardegna AND Italy (the project core).
const matchesByPlayer = new Map();
const geoOf = new Map(); // pid -> { byCountry: Map(cc -> {events:Set, games, last}), sardegna }
for (const m of matchRows) {
  const ev = events[m.eventId] || {};
  const cc = (ev.country || "").toUpperCase();
  for (const pid of [m.a, m.b]) {
    let arr = matchesByPlayer.get(pid);
    if (!arr) { arr = []; matchesByPlayer.set(pid, arr); }
    arr.push(m);
    let g = geoOf.get(pid);
    if (!g) { g = { byCountry: new Map(), sardegna: false }; geoOf.set(pid, g); }
    if (cc) {
      let c = g.byCountry.get(cc);
      if (!c) { c = { events: new Set(), games: 0, last: "" }; g.byCountry.set(cc, c); }
      c.events.add(m.eventId); c.games++;
      if ((ev.date || "") > c.last) c.last = ev.date || "";
    }
    if (ev.region === "Sardegna") g.sardegna = true;
  }
}
// Registration-only events (post-2026-06-19 UVS pairing lockdown) have NO matches;
// players link to them via PLACEMENTS (public registrations endpoint). Fold those
// links into geo so those players still get country/Sardegna/continent scopes.
for (const [eid, info] of Object.entries(PLACEMENTS)) {
  const ev = events[eid] || {};
  const cc = (ev.country || "").toUpperCase();
  for (const pid of Object.keys(info.places)) {
    let g = geoOf.get(pid);
    if (!g) { g = { byCountry: new Map(), sardegna: false }; geoOf.set(pid, g); }
    if (cc) {
      let c = g.byCountry.get(cc);
      if (!c) { c = { events: new Set(), games: 0, last: "" }; g.byCountry.set(cc, c); }
      c.events.add(Number(eid));
      if ((ev.date || "") > c.last) c.last = ev.date || "";
    }
    if (ev.region === "Sardegna") g.sardegna = true;
  }
}

const scopesOf = new Map(); // pid -> Set of scope keys
const homeCountryOf = new Map(); // pid -> ISO2 home country (for the leaderboard flag)
for (const [pid, g] of geoOf) {
  const scopes = new Set(["global"]);
  let home = null, best = null;
  for (const [cc, c] of g.byCountry) {
    const k = [c.events.size, c.games, c.last];
    const better = !best || k[0] > best[0] ||
      (k[0] === best[0] && k[1] > best[1]) ||
      (k[0] === best[0] && k[1] === best[1] && k[2] > best[2]);
    if (better) { best = k; home = cc; }
  }
  if (home) {
    scopes.add(home.toLowerCase());
    const cont = continentOf(home);
    if (cont) scopes.add(cont.toLowerCase());
  }
  if (g.sardegna) { scopes.add("sardegna"); scopes.add("it"); scopes.add("eu"); }
  scopesOf.set(pid, scopes);
  if (home) homeCountryOf.set(pid, home);
}

// --- build full player objects ---
// Connectivity / cross-pool calibration:
//  - fewer than MIN_OPPONENTS distinct opponents → rating is a tiny-clique
//    artifact → provisional (hidden by default everywhere);
//  - SOS DEFLATION (replaces the old hard MIN_SOS cutoff, which excluded even
//    national #1s — e.g. a 1866 player whose avgOpp was 1557): instead of hiding
//    weakly-connected players, we DISCOUNT a rating by how far its schedule sits
//    below a globally-competitive anchor, so everyone appears but a big fish from
//    a weak pond sinks below players who beat genuinely strong fields.
//      displayed = raw − DEFLATE_K · max(0, SOS_REF − avgOpp)
//    avgOpp = mean of opponents' CURRENT (raw) ratings. SOS_REF≈ where the
//    globally-connected elite sit (Alanzq-tier avgOpp ~1680); K tunes severity.
//    Simulated worldwide: Alanzq (227 opp, avgOpp 1680) → #1; weak-schedule
//    inflations (e.g. 31-opp/1479-avgOpp 2050s) drop ~10 places; MARTIX (1866,
//    avgOpp 1557) shows ~1757 and is now RANKED instead of excluded.
const MIN_OPPONENTS = 25;
const SOS_REF = Number(process.env.SOS_REF || 1650);
const DEFLATE_K = Number(process.env.DEFLATE_K || 0.75);
const deflateRating = (raw, avgOpp) =>
  raw == null ? null : Math.round(raw - DEFLATE_K * Math.max(0, SOS_REF - (avgOpp || 0)));
const CONT_KEYS = new Set(Object.keys(CONTINENT_LABELS).map((k) => k.toLowerCase()));

// --- Rating reliability (council 2026-06-22): boards rank on a CONSERVATIVE lower
// bound CR = rating - K*RD (kills small-sample hot streaks), behind hard eligibility
// gates (min events/games, RD cap). Option-B deflation: local single-pool boards
// show RAW (everyone shares one pond), only global/continental deflate. ---
const RATING_K = Number(process.env.RATING_CONSERVATISM_K || 1.5);
const MIN_EVENTS = Number(process.env.MIN_EVENTS || 5);            // <5 distinct events = not a sample
const MIN_GAMES = Number(process.env.MIN_GAMES_ESTABLISHED || 40); // raised from effective 25
const PROVISIONAL_RD = Number(process.env.PROVISIONAL_RD || 90);   // tightened from 110
const conservative = (rating, rd) => rating == null ? null : Math.round(rating - RATING_K * (rd ?? 0));
const isLocalScope = (scope) => scope !== "global" && !CONT_KEYS.has(scope);
// scope-appropriate POINT rating: raw on local boards, deflated on global/continental.
const scopeRatingOf = (p, scope) => isLocalScope(scope) ? p.ratingRaw : p.rating;

// Handles + records for players who exist ONLY via placements (no match-based
// rating). Their W/L/D comes from the registrations endpoint (stored on placements).
const handleById = new Map(db.prepare("SELECT id, handle FROM players").all().map((r) => [String(r.id), r.handle]));
const placeRecord = new Map(); // pid -> {w,l,d,last}
for (const pr of db.prepare("SELECT pl.player_id pid, pl.wins w, pl.losses l, pl.draws d, e.date date FROM placements pl JOIN events e ON e.id = pl.event_id WHERE pl.wins IS NOT NULL").all()) {
  let r = placeRecord.get(String(pr.pid));
  if (!r) { r = { w: 0, l: 0, d: 0, last: "" }; placeRecord.set(String(pr.pid), r); }
  r.w += pr.w || 0; r.l += pr.l || 0; r.d += pr.d || 0;
  if ((pr.date || "") > r.last) r.last = pr.date || "";
}

// Career match-win % per player (floored at 1/3, MTG-standard), used to compute
// each player's career OMW% = average of their opponents' match-win %.
const careerMw = new Map();
for (const p of ratingRows) {
  const g = (p.wins ?? 0) + (p.losses ?? 0) + (p.draws ?? 0);
  if (g > 0) careerMw.set(String(p.id), Math.max(1 / 3, (3 * (p.wins ?? 0) + (p.draws ?? 0)) / (3 * g)));
}

const players = ratingRows.map((p) => {
  let bestWin = null, worstLoss = null;
  const oppSet = new Set();
  const evSet = new Set();
  let oppSum = 0, oppN = 0;
  let omwSum = 0, omwN = 0;     // career OMW%: mean of opponents' match-win %
  let gW = 0, gL = 0;            // game-level wins/losses (GWP%), only where game data exists
  const seq = [];               // chronological W/L/D sequence (matchesByPlayer is date-ASC)
  for (const m of matchesByPlayer.get(p.id) || []) {
    const meA = m.a === p.id;
    const oppId = meA ? m.b : m.a;
    if (m.eventId != null) evSet.add(m.eventId);
    if (oppId != null) {
      oppSet.add(oppId);
      const oppCur = ratingMap.get(oppId)?.rating;
      if (oppCur != null) { oppSum += oppCur; oppN++; }
      const oppMw = careerMw.get(String(oppId));
      if (oppMw != null) { omwSum += oppMw; omwN++; }
    }
    const won = (m.winner === "A" && meA) || (m.winner === "B" && !meA);
    const lost = (m.winner === "A" && !meA) || (m.winner === "B" && meA);
    seq.push(won ? "W" : lost ? "L" : "D");
    // GWP%: count games only where the source carried a score (new-pairing events).
    if (m.ga != null && m.gb != null) { gW += meA ? m.ga : m.gb; gL += meA ? m.gb : m.ga; }
    const oppRating = snapAt.get(`${oppId}:${m.eventId}`);
    if (oppRating == null) continue;
    const rec = { oppId, oppHandle: handleOf(ratingMap.get(oppId)?.handle, oppId), oppRating,
      eventName: events[m.eventId]?.name || "", date: m.date };
    if (won && (!bestWin || oppRating > bestWin.oppRating)) bestWin = rec;
    if (lost && (!worstLoss || oppRating < worstLoss.oppRating)) worstLoss = rec;
  }
  const avgOpp = oppN ? Math.round(oppSum / oppN) : 0;
  const omw = omwN ? Math.round(omwSum / omwN * 1000) / 10 : null;   // career OMW% (1 dp)
  // Streak & form (from the chronological sequence) + GWP% (game win %).
  let bestStreak = 0, run = 0;
  for (const r of seq) { if (r === "W") { run++; if (run > bestStreak) bestStreak = run; } else run = 0; }
  let curT = null, curN = 0;
  for (let i = seq.length - 1; i >= 0; i--) { if (curT == null) { curT = seq[i]; curN = 1; } else if (seq[i] === curT) curN++; else break; }
  const form = seq.slice(-10).reverse();   // last 10 results, most-recent first
  const gN = gW + gL;
  const gwp = gN ? Math.round(1000 * gW / gN) / 10 : null;   // one decimal, null if no game data
  // Established only if a real sample: enough distinct events AND games AND a tight
  // enough RD (a 3-event/31-game hot streak with RD 83 must NOT rank). Plus the
  // legacy opponent floor / base-provisional flags.
  const provisional = !!p.provisional || oppSet.size < MIN_OPPONENTS
    || evSet.size < MIN_EVENTS || p.games < MIN_GAMES || p.rd > PROVISIONAL_RD;
  return {
    id: p.id,
    handle: handleOf(p.handle, p.id),
    // raw + SOS-deflated both kept; the displayed/sorted value is chosen PER SCOPE
    // (raw locally, deflated globally) and ranked by the conservative CR = x - K*RD.
    rating: deflateRating(p.rating, avgOpp), ratingRaw: Math.round(p.rating), rd: p.rd, vol: p.vol,
    games: p.games, wins: p.wins, losses: p.losses, draws: p.draws, events: evSet.size,
    provisional, avgOpp, omw, lastDate: p.lastDate, country: homeCountryOf.get(String(p.id)) || null,
    regions: [...(scopesOf.get(p.id) || [])].filter((k) => k === "sardegna").map(() => "Sardegna"),
    scopes: [...(scopesOf.get(p.id) || [])],
    series: seriesOf.get(p.id) || [],
    bestWin, worstLoss,
    // streak/form (always available from matches) + game-level GWP% (null until
    // new-pairing events accumulate game scores — historical matches lack them).
    form, streak: curT ? { type: curT, n: curN } : null, bestStreak,
    gwp, gameWins: gN ? gW : null, gameLosses: gN ? gL : null,
    palmares: [...(palmaresOf.get(String(p.id)) || new Map())]
      .sort((a, b) => b[0] - a[0])
      .map(([tier, c]) => ({ tier, label: TIERS[tier], ...c })),
    majors: (majorsOf.get(String(p.id)) || [])
      .sort((a, b) => b.tier - a.tier || a.rank - b.rank),
    race: raceOf.get(String(p.id)) || { points: 0, events: 0, first: 0, second: 0, third: 0 },
  };
});
// Append registration-only players (placements/Race but no match-based rating):
// unranked ELO (provisional, no pairings) but full Race/standings presence.
const ratedIds = new Set(ratingRows.map((r) => String(r.id)));
for (const id of raceOf.keys()) {
  if (ratedIds.has(String(id))) continue;
  const rec = placeRecord.get(String(id)) || { w: 0, l: 0, d: 0, last: "" };
  players.push({
    id,
    handle: handleOf(handleById.get(String(id)), id),
    rating: null, rd: null, vol: null,
    games: rec.w + rec.l + rec.d, wins: rec.w, losses: rec.l, draws: rec.d,
    provisional: true, avgOpp: 0, omw: null, lastDate: rec.last, country: homeCountryOf.get(String(id)) || null,
    regions: [...(scopesOf.get(id) || [])].filter((k) => k === "sardegna").map(() => "Sardegna"),
    scopes: [...(scopesOf.get(id) || [])],
    series: [], bestWin: null, worstLoss: null,
    form: [], streak: null, bestStreak: 0, gwp: null, gameWins: null, gameLosses: null,
    palmares: [...(palmaresOf.get(String(id)) || new Map())].sort((a, b) => b[0] - a[0]).map(([tier, c]) => ({ tier, label: TIERS[tier], ...c })),
    majors: (majorsOf.get(String(id)) || []).sort((a, b) => b.tier - a.tier || a.rank - b.rank),
    race: raceOf.get(String(id)) || { points: 0, events: 0, first: 0, second: 0, third: 0 },
  });
}
// Rated first (desc); unranked (null rating) sink to the bottom.
players.sort((a, b) => (b.rating ?? -Infinity) - (a.rating ?? -Infinity));
const playerById = new Map(players.map((p) => [p.id, p]));

// Opted-out players are kept in the rating math but never published.
const publicPlayers = players.filter((p) => !EXCLUDED.has(String(p.id)));
if (players.length !== publicPlayers.length) {
  console.log(`GDPR opt-out: ${players.length - publicPlayers.length} player(s) anonymized & unlisted.`);
}

// --- per-scope leaderboard positions (embedded in player profiles) ---
// ELO rank = position by rating among ALL (public) players of the scope; Race
// rank = position by 12-month points among scoring players of the scope.
const allScopes = new Set(["global", ...publicPlayers.flatMap((p) => p.scopes)]);
const positionsOf = new Map(); // pid -> [{scope, elo, of, race, raceOf}]
for (const scope of allScopes) {
  const inScope = scope === "global" ? publicPlayers : publicPlayers.filter((p) => p.scopes.includes(scope));
  // Provisional ratings are UNRANKED. Established players are ranked by the
  // scope-appropriate CONSERVATIVE rating (raw locally / deflated globally, minus K*RD).
  const ranked = inScope.filter((p) => !p.provisional)
    .map((p) => ({ p, cr: conservative(scopeRatingOf(p, scope), p.rd) }))
    .sort((a, b) => b.cr - a.cr)
    .map((x) => x.p);
  const eloRank = new Map(ranked.map((p, i) => [p.id, i + 1]));
  const byRace = inScope.filter((p) => p.race.points > 0)
    .sort((a, b) => b.race.points - a.race.points || b.race.first - a.race.first);
  const raceRank = new Map(byRace.map((p, i) => [p.id, i + 1]));
  inScope.forEach((p) => {
    let arr = positionsOf.get(p.id);
    if (!arr) { arr = []; positionsOf.set(p.id, arr); }
    arr.push({ scope, elo: eloRank.get(p.id) ?? null, of: ranked.length, race: raceRank.get(p.id) ?? null, raceOf: byRace.length });
  });
}
// display order: Sardegna, countries, continents, global
const scopeWeight = (s) => (s === "sardegna" ? 0 : s === "global" ? 3 : CONT_KEYS.has(s) ? 2 : 1);

mkdirSync("site", { recursive: true });

// --- 1) legacy data.json (Sardegna-scoped, keeps live page working) ---
{
  const sardPlayers = publicPlayers.filter((p) => p.scopes.includes("sardegna"));
  const sardIds = new Set(sardPlayers.map((p) => p.id));
  const sardMatches = matchRows.filter((m) => sardIds.has(m.a) || sardIds.has(m.b));
  const sardEvents = {};
  for (const m of sardMatches) if (events[m.eventId]) sardEvents[m.eventId] = events[m.eventId];
  for (const e of eventsRows) if (e.region === "Sardegna") sardEvents[e.id] = events[e.id];
  const legacy = {
    generatedAt: new Date().toISOString(),
    counts: { players: sardPlayers.length, matches: sardMatches.length,
      events: eventsRows.filter((e) => e.region === "Sardegna").length },
    regions: ["Sardegna"],
    events: sardEvents, players: sardPlayers, matches: sardMatches,
  };
  writeFileSync("site/data.json", JSON.stringify(legacy));
  console.log(`data.json (legacy, Sardegna): ${sardPlayers.length} players, ${sardMatches.length} matches`);
}

// --- 2) leaderboard shards per scope ---
const lbRow = (p) => ({
  id: p.id, handle: p.handle, rating: p.rating, rd: p.rd,
  games: p.games, wins: p.wins, losses: p.losses, draws: p.draws,
  provisional: p.provisional, race: p.race, country: p.country,
});
rmSync("site/leaderboards", { recursive: true, force: true });
mkdirSync("site/leaderboards", { recursive: true });
const scopeMeta = [];
// Players appearing in ANY leaderboard shard: these are the only ones a visitor
// can click/search to open a profile, so their profile shards must always be
// regenerated — even during the backfill (PROFILE_SCOPES) — or the board and the
// profile drift apart (e.g. board shows a player as ranked while their stale
// profile still says "provisional").
const leaderboardIds = new Set();
// Big scopes are capped: a worldwide board would be a 10MB+ download. Profiles
// and positions still cover EVERY player; the shard just lists the top rows.
const MAX_ROWS = Number(process.env.LEADERBOARD_MAX_ROWS || 5000);
for (const scope of allScopes) {
  const inScope = scope === "global" ? publicPlayers : publicPlayers.filter((p) => p.scopes.includes(scope));
  // RATING board: ranked by the scope-appropriate CONSERVATIVE rating (raw locally /
  // deflated globally, minus K*RD). The displayed `rating` IS that CR; `ratingPoint`
  // keeps the point estimate for the row expansion. (Circuito ignores `rating`.)
  const ratingPool = inScope.slice()
    .sort((a, b) => conservative(scopeRatingOf(b, scope), b.rd) - conservative(scopeRatingOf(a, scope), a.rd));
  // CIRCUITO board: ranked by placement points (schedule-independent). Union the top
  // rows of each pool so registration-only / lower-rated high-Circuit players (who
  // fall outside the rating top-N) still appear in the Circuito view.
  const racePool = inScope.filter((p) => p.race.points > 0)
    .sort((a, b) => b.race.points - a.race.points || b.race.first - a.race.first);
  const seen = new Set();
  const rows = [];
  const push = (p) => {
    if (seen.has(p.id)) return;
    seen.add(p.id);
    const point = scopeRatingOf(p, scope);
    rows.push({ ...lbRow(p), rating: conservative(point, p.rd), ratingPoint: point, events: p.events, rated: true });
  };
  ratingPool.slice(0, MAX_ROWS).forEach(push);
  racePool.slice(0, MAX_ROWS).forEach(push);
  if (!rows.length) continue;
  for (const r of rows) leaderboardIds.add(r.id);
  writeFileSync(`site/leaderboards/${scope}.json`,
    JSON.stringify({ scope, generatedAt: new Date().toISOString(), totalPlayers: rows.length, players: rows }));
  scopeMeta.push({ scope, players: ratingPool.length });
}

// --- 2b) Circuit shards PER SCOPE (so the Sardegna/country/global filter works on
// every view): for each scope -> current set (soft-transition blended), each started
// set (frozen history), all-time (sum of per-set scores + peak). index.json (global)
// lists the sets. Filtering the global top-N client-side would NOT work — local
// players fall outside the global cap — hence true per-scope standings.
{
  const CIRC_MAX = Number(process.env.CIRCUIT_MAX_ROWS || 5000);
  const setPoints = (pid, setId) => raceSetOf.get(pid)?.get(setId) || null;
  const idx = SET_DATES.findIndex((s) => s.id === currentSetId);
  const prevSetId = idx > 0 ? SET_DATES[idx - 1].id : null;
  const RAMP = Number(process.env.TRANSITION_RAMP_DAYS || 21);
  const D = (NOW - Date.parse(SET_DATES[idx].start)) / 864e5;
  const wPrev = prevSetId ? clampN(0, 1, 1 - D / RAMP) : 0;
  const startedSets = SET_DATES.filter((s) => Date.parse(s.start) <= NOW);

  const writeScope = (scope, pub) => {
    mkdirSync(`site/circuit/${scope}`, { recursive: true });
    for (const s of startedSets) {
      const rows = [];
      for (const pl of pub) { const sc = setPoints(pl.id, s.id); if (sc && sc.points > 0) rows.push({ id: pl.id, h: pl.h, c: pl.c, points: sc.points, premierPts: sc.premierPts, events: sc.events, first: sc.first }); }
      rows.sort((a, b) => b.points - a.points || b.premierPts - a.premierPts || b.first - a.first);
      writeFileSync(`site/circuit/${scope}/${s.id}.json`, JSON.stringify({ set: s.id, name: s.name, start: s.start, scope, current: s.id === currentSetId, totalPlayers: rows.length, players: rows.slice(0, CIRC_MAX) }));
    }
    const cur = [];
    for (const pl of pub) { const c = setPoints(pl.id, currentSetId)?.points || 0; const p = (wPrev > 0 && prevSetId) ? (setPoints(pl.id, prevSetId)?.points || 0) : 0; const pts = Math.round(c + wPrev * p); if (pts > 0) cur.push({ id: pl.id, h: pl.h, c: pl.c, points: pts, curPoints: c }); }
    cur.sort((a, b) => b.points - a.points || b.curPoints - a.curPoints);
    writeFileSync(`site/circuit/${scope}/current.json`, JSON.stringify({ set: currentSetId, name: SET_DATES[idx].name, start: SET_DATES[idx].start, scope, prevSet: prevSetId, transitionWeight: Math.round(wPrev * 100) / 100, totalPlayers: cur.length, players: cur.slice(0, CIRC_MAX) }));
    const at = [];
    for (const pl of pub) { const cm = raceSetOf.get(pl.id); if (!cm) continue; let sum = 0, peak = 0, sets = 0; for (const [, sc] of cm) if (sc.points > 0) { sum += sc.points; sets++; if (sc.points > peak) peak = sc.points; } if (sum > 0) at.push({ id: pl.id, h: pl.h, c: pl.c, points: sum, peak, sets }); }
    at.sort((a, b) => b.points - a.points || b.peak - a.peak);
    writeFileSync(`site/circuit/${scope}/alltime.json`, JSON.stringify({ scope, totalPlayers: at.length, players: at.slice(0, CIRC_MAX) }));
  };

  let scopeCount = 0;
  for (const scope of allScopes) {
    const inScope = scope === "global" ? publicPlayers : publicPlayers.filter((p) => p.scopes.includes(scope));
    if (!inScope.length) continue;
    writeScope(scope, inScope.map((p) => ({ id: String(p.id), h: p.handle, c: p.country })));
    scopeCount++;
  }
  const setMeta = startedSets.map((s) => {
    let n = 0; for (const p of publicPlayers) { const sc = setPoints(String(p.id), s.id); if (sc && sc.points > 0) n++; }
    return { set: s.id, name: s.name, start: s.start, players: n };
  });
  writeFileSync("site/circuit/index.json", JSON.stringify({ generatedAt: new Date().toISOString(), currentSet: currentSetId, transitionWeight: Math.round(wPrev * 100) / 100, sets: setMeta }));
  console.log(`circuit: ${scopeCount} scopes × (${startedSets.length} sets + current + all-time), current=${currentSetId}, wPrev=${wPrev.toFixed(2)}`);
}

const countries = scopeMeta.filter((s) => /^[a-z]{2}$/.test(s.scope) && !CONTINENT_LABELS[s.scope.toUpperCase()]);
// Don't advertise scopes that aren't real yet: a continent only counts once it
// has >=2 ingested countries, and "global" only once >=2 countries exist —
// otherwise they'd just duplicate the single country (e.g. Europe == Italy).
const countriesPerContinent = new Map();
for (const c of countries) {
  const cont = (continentOf(c.scope) || "").toLowerCase();
  if (cont) countriesPerContinent.set(cont, (countriesPerContinent.get(cont) || 0) + 1);
}
const continents = scopeMeta.filter((s) =>
  CONTINENT_LABELS[s.scope.toUpperCase()] && (countriesPerContinent.get(s.scope) || 0) >= 2);
const special = scopeMeta.filter((s) =>
  s.scope === "sardegna" || (s.scope === "global" && countries.length >= 2));
writeFileSync("site/leaderboards/index.json", JSON.stringify({
  generatedAt: new Date().toISOString(),
  special, continents, countries,
}));
console.log(`leaderboards: ${scopeMeta.length} scopes (${countries.length} countries, ${continents.length} continents)`);

// --- 3) per-player profile shards ---
// PROFILE_SCOPES (e.g. "it") limits which profiles are (re)generated, so the
// worldwide backfill doesn't republish all ~94k profiles every run — only the
// live scopes stay fresh; the full set is generated once PROFILE_SCOPES is
// cleared (backfill done). Leaderboards above always cover everyone.
const PROFILE_SCOPES = (process.env.PROFILE_SCOPES || "").split(",").map((s) => s.trim()).filter(Boolean);
const profilePlayers = PROFILE_SCOPES.length
  // always include everyone shown on a leaderboard (clickable/searchable) so the
  // board and the profile never disagree, plus the configured scopes.
  ? publicPlayers.filter((p) => leaderboardIds.has(p.id) || p.scopes.some((sc) => PROFILE_SCOPES.includes(sc)))
  : publicPlayers;
// Per-player EVENT RESULTS (placement + record per tournament) — the profile's
// PRIMARY list now that match-by-match pairings are frozen (UVS lockdown).
// Placement comes from `placements`; the W/L/D record comes from the registrations
// data (new events) OR — for historical events — is DERIVED from the exact `matches`
// we already have (no need to re-fetch: count W/L/D per player per event).
const recOf = new Map(); // `${pid}:${eid}` -> {w,l,d}
for (const m of matchRows) {
  for (const pid of [m.a, m.b]) {
    if (pid == null) continue;
    const k = `${pid}:${m.eventId}`;
    let r = recOf.get(k);
    if (!r) { r = { w: 0, l: 0, d: 0 }; recOf.set(k, r); }
    const meA = m.a === pid;
    if (m.winner === "draw") r.d++;
    else if ((m.winner === "A" && meA) || (m.winner === "B" && !meA)) r.w++;
    else r.l++;
  }
}
// Per-event RATING change (Glicko delta). Glicko runs in WEEKLY periods, so all of
// a player's events in one week share ONE end-of-period snapshot rating. A naive
// per-event delta dumps the whole week onto the FIRST event and shows 0 for the
// rest (e.g. an RQ WON the day after a pre-event would show 0 while the pre-event
// showed +51). So we group consecutive same-rating snapshots (= one period) and
// attribute that period's change to its FLAGSHIP event (highest tier, then largest
// field); the other events in the period get 0 (hidden). First period = vs 1500 seed.
const rdeltaOf = new Map();
const evTier = (eid) => events[eid]?.tier || 0;
const evField = (eid) => fieldSizeOf.get(String(eid)) || 0;
for (const [pid, arr] of seriesOf) {
  let prev = 1500, i = 0;
  while (i < arr.length) {
    const r = arr[i].rating;
    let j = i; const group = [];
    while (j < arr.length && arr[j].rating === r) { group.push(arr[j].eventId); j++; }
    let flag = group[0];
    for (const eid of group)
      if (evTier(eid) > evTier(flag) || (evTier(eid) === evTier(flag) && evField(eid) > evField(flag))) flag = eid;
    const delta = Math.round(r - prev);
    for (const eid of group) rdeltaOf.set(`${pid}:${eid}`, eid === flag ? delta : 0);
    prev = r; i = j;
  }
}

const resultsByPlayer = new Map();
for (const r of db.prepare("SELECT player_id pid, event_id eid, rank, participants, wins, losses, draws FROM placements").all()) {
  const ev = events[r.eid];
  if (!ev) continue;
  let arr = resultsByPlayer.get(String(r.pid));
  if (!arr) { arr = []; resultsByPlayer.set(String(r.pid), arr); }
  const der = r.wins == null ? recOf.get(`${r.pid}:${r.eid}`) : null; // historical fallback from matches
  // Points earned at this event, per system:
  //  cpts    = Circuit points the finish is worth (best-N of these make the total)
  //  counted = whether it's currently in the player's best-N 12-month window
  //  rdelta  = Glicko rating change (only frozen Classic-era events have one)
  const n = fieldSizeOf.get(String(r.eid)) ?? r.participants;
  const cpts = ev.tier ? eventPoints(r.rank, n, ev.tier) : 0;
  const counted = countedEidsOf.get(String(r.pid))?.has(String(r.eid)) ?? false;
  const rdelta = rdeltaOf.get(`${r.pid}:${r.eid}`) ?? null;
  arr.push({
    eventId: r.eid, date: ev.date, eventName: ev.name, tier: ev.tier, tierLabel: ev.tierLabel,
    rank: r.rank, of: r.participants,
    wins: r.wins ?? der?.w ?? null, losses: r.losses ?? der?.l ?? null, draws: r.draws ?? der?.d ?? null,
    cpts, counted, rdelta,
  });
}

rmSync("site/players", { recursive: true, force: true });
mkdirSync("site/players", { recursive: true });
for (const p of profilePlayers) {
  const ms = (matchesByPlayer.get(p.id) || []).slice()
    .sort((x, y) => String(y.date).localeCompare(String(x.date)))
    .map((m) => {
      const meA = m.a === p.id;
      const oppId = meA ? m.b : m.a;
      const result = m.winner === "draw" ? "D"
        : ((m.winner === "A" && meA) || (m.winner === "B" && !meA)) ? "W" : "L";
      const hasG = m.ga != null && m.gb != null;
      return { id: m.id, oppId, oppHandle: playerById.get(oppId)?.handle || "?",
        result, date: m.date, eventId: m.eventId, eventName: events[m.eventId]?.name || "",
        gf: hasG ? (meA ? m.ga : m.gb) : null, ga: hasG ? (meA ? m.gb : m.ga) : null };
    });
  const positions = (positionsOf.get(p.id) || []).slice()
    .sort((a, b) => scopeWeight(a.scope) - scopeWeight(b.scope) || a.scope.localeCompare(b.scope));
  const results = (resultsByPlayer.get(String(p.id)) || []).slice()
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  // `results` = the new primary list (events + placements). `matches` = frozen
  // exact head-to-head (the "Classic" era, up to the UVS lockdown).
  writeFileSync(`site/players/${p.id}.json`, JSON.stringify({ ...p, positions, results, matches: ms }));
}
console.log(`players: ${profilePlayers.length} profile shards${PROFILE_SCOPES.length ? ` (scopes ${PROFILE_SCOPES.join(",")}; full set ${publicPlayers.length})` : ""}`);

// --- 3b) per-tournament shards: full final standings (placement + record), so a
// result row on a profile is clickable → the tournament's complete ranking, each
// player clickable. W/L/D from registrations (new events) or derived from matches.
const handleOfId = new Map(publicPlayers.map((p) => [String(p.id), p.handle]));

// REAL Swiss tiebreakers (OMW% / GW% / OGW%), computed per event from the exact
// matches — ONLY for events whose matches carry GAME SCORES (the new-pairing
// events; historical pre-lockdown matches stored only the winner). Gating on
// game data keeps this bounded → memory-safe (build-site already runs near the
// heap cap). Standard MTG formulas with the 1/3 floor on each opponent term.
const FLOOR = 1 / 3;
const tbByEvent = new Map(); // eid -> Map(pid -> {opps:Set, mw,ml,md, gf,gl})
for (const m of matchRows) {
  if (m.ga == null || m.gb == null) continue; // need game scores for GW%/OGW%
  let pm = tbByEvent.get(m.eventId);
  if (!pm) { pm = new Map(); tbByEvent.set(m.eventId, pm); }
  const rec = (pid) => { let x = pm.get(pid); if (!x) { x = { opps: new Set(), mw: 0, ml: 0, md: 0, gf: 0, gl: 0 }; pm.set(pid, x); } return x; };
  const A = rec(m.a), B = rec(m.b);
  A.opps.add(m.b); B.opps.add(m.a);
  A.gf += m.ga; A.gl += m.gb; B.gf += m.gb; B.gl += m.ga;
  if (m.winner === "draw") { A.md++; B.md++; }
  else if (m.winner === "A") { A.mw++; B.ml++; }
  else { B.mw++; A.ml++; }
}
const tbFinal = new Map(); // eid -> Map(pid -> {omw, gw, ogw}) as percent (1 dp)
for (const [eid, pm] of tbByEvent) {
  const mwp = new Map(), gwp = new Map();
  for (const [pid, x] of pm) {
    const mp = x.mw + x.ml + x.md, gp = x.gf + x.gl;
    mwp.set(pid, mp ? Math.max(FLOOR, (3 * x.mw + x.md) / (3 * mp)) : FLOOR);
    gwp.set(pid, gp ? Math.max(FLOOR, x.gf / gp) : FLOOR);
  }
  const out = new Map();
  for (const [pid, x] of pm) {
    const opps = [...x.opps];
    const avg = (f) => opps.length ? opps.reduce((s, o) => s + f(o), 0) / opps.length : FLOOR;
    out.set(pid, {
      omw: Math.round(avg((o) => mwp.get(o) ?? FLOOR) * 1000) / 10,
      gw: Math.round((gwp.get(pid) ?? FLOOR) * 1000) / 10,
      ogw: Math.round(avg((o) => gwp.get(o) ?? FLOOR) * 1000) / 10,
    });
  }
  tbFinal.set(eid, out);
}

const standByEvent = new Map(); // eid -> { part, rows:[] }
for (const r of db.prepare("SELECT event_id eid, player_id pid, rank, participants, wins, losses, draws FROM placements").all()) {
  const pid = String(r.pid);
  if (!handleOfId.has(pid)) continue; // skip opted-out / unknown
  let a = standByEvent.get(r.eid);
  if (!a) { a = { part: r.participants, rows: [] }; standByEvent.set(r.eid, a); }
  const der = r.wins == null ? recOf.get(`${pid}:${r.eid}`) : null;
  const tb = tbFinal.get(r.eid)?.get(pid);
  a.rows.push({ id: pid, h: handleOfId.get(pid), rank: r.rank,
    w: r.wins ?? der?.w ?? null, l: r.losses ?? der?.l ?? null, d: r.draws ?? der?.d ?? null,
    omw: tb?.omw ?? null, gw: tb?.gw ?? null, ogw: tb?.ogw ?? null });
}
rmSync("site/events", { recursive: true, force: true });
mkdirSync("site/events", { recursive: true });
let evShards = 0;
for (const [eid, a] of standByEvent) {
  const ev = events[eid];
  if (!ev) continue;
  a.rows.sort((x, y) => x.rank - y.rank);
  writeFileSync(`site/events/${eid}.json`, JSON.stringify({
    id: eid, name: ev.name, date: ev.date, tier: ev.tier, tierLabel: ev.tierLabel,
    country: ev.country, region: ev.region, participants: a.part || a.rows.length,
    standings: a.rows,
  }));
  evShards++;
}
console.log(`tournaments: ${evShards} event shards`);

// --- 4) search index: ALWAYS the full player set (compact id+handle), decoupled
// from profile-shard generation. The leaderboards are capped at the top rows, so
// without this a player below the cap can't be found at all. It's cheap (~30 B/row)
// so we publish it every run even though heavy profile shards are regenerated on a
// lighter cadence (PROFILE_SCOPES) — search must find anyone, all the time.
writeFileSync("site/leaderboards/search.json", JSON.stringify({
  generatedAt: new Date().toISOString(),
  players: publicPlayers.map((p) => ({ i: p.id, h: p.handle, r: p.rating, g: p.games, pr: p.provisional ? 1 : 0 })),
}));
console.log(`search index: ${publicPlayers.length} players (full set)`);
