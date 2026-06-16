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
  if (/skirmish/i.test(n)) return 3;
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
  SELECT id, event_id AS eventId, date, player_a AS a, player_b AS b, winner
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

const ratingRows = db.prepare(`
  SELECT r.player_id AS id, p.handle, r.rating, r.rd, r.vol,
         r.games, r.wins, r.losses, r.draws, r.provisional, r.last_date AS lastDate
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
const RACE_PRESTIGE = { 4: 1.5, 5: 2 };  // RQ ×1.5, Regional ×2, else ×1
// Symbolic "you played" floor — purely placement-driven otherwise. A fixed
// per-tier floor (RQ=50) was wrong: just attending a 1645-player RQ beat WINNING
// a small Nexus. Mere participation must never outweigh a real result, so the
// floor is a token 1 point; real points come from beating opponents (placeFactor).
const RACE_FLOOR = 1;
// Top-heavy decay by finishing position relative to field size: 1st → 1.0, last → ~0.
const placeFactor = (rank, n) => Math.max(0, 1 - Math.log(rank) / Math.log(n + 1));
const raceCutoff = Date.now() - 365 * 24 * 3600e3;
const raceOf = new Map();
for (const [eid, info] of Object.entries(PLACEMENTS)) {
  const ev = events[eid];
  if (!ev?.tier) continue;
  const fieldSize = Object.keys(info.places).length;
  const inRace = ev.date && Date.parse(ev.date) >= raceCutoff;
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
      // participants = real placement rows (deduped by PK), not the stored
      // `participants` column which an old paging bug inflated on a few majors.
      arr.push({ eventName: ev.name, date: ev.date, tier: ev.tier, label: ev.tierLabel, rank, participants: Object.keys(info.places).length });
    }
    if (inRace) {
      let r = raceOf.get(pid);
      if (!r) { r = { points: 0, events: 0, first: 0, second: 0, third: 0 }; raceOf.set(pid, r); }
      r.points += Math.round(
        Math.max(RACE_FLOOR, fieldSize * placeFactor(rank, fieldSize) * (RACE_PRESTIGE[ev.tier] || 1)));
      r.events++;
      if (rank === 1) r.first++; else if (rank === 2) r.second++; else if (rank === 3) r.third++;
    }
  }
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
const scopesOf = new Map(); // pid -> Set of scope keys
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
}

// --- build full player objects ---
const players = ratingRows.map((p) => {
  let bestWin = null, worstLoss = null;
  for (const m of matchesByPlayer.get(p.id) || []) {
    const meA = m.a === p.id;
    const oppId = meA ? m.b : m.a;
    const won = (m.winner === "A" && meA) || (m.winner === "B" && !meA);
    const lost = (m.winner === "A" && !meA) || (m.winner === "B" && meA);
    const oppRating = snapAt.get(`${oppId}:${m.eventId}`);
    if (oppRating == null) continue;
    const rec = { oppId, oppHandle: handleOf(ratingMap.get(oppId)?.handle, oppId), oppRating,
      eventName: events[m.eventId]?.name || "", date: m.date };
    if (won && (!bestWin || oppRating > bestWin.oppRating)) bestWin = rec;
    if (lost && (!worstLoss || oppRating < worstLoss.oppRating)) worstLoss = rec;
  }
  return {
    id: p.id,
    handle: handleOf(p.handle, p.id),
    rating: p.rating, rd: p.rd, vol: p.vol,
    games: p.games, wins: p.wins, losses: p.losses, draws: p.draws,
    provisional: !!p.provisional, lastDate: p.lastDate,
    regions: [...(scopesOf.get(p.id) || [])].filter((k) => k === "sardegna").map(() => "Sardegna"),
    scopes: [...(scopesOf.get(p.id) || [])],
    series: seriesOf.get(p.id) || [],
    bestWin, worstLoss,
    palmares: [...(palmaresOf.get(String(p.id)) || new Map())]
      .sort((a, b) => b[0] - a[0])
      .map(([tier, c]) => ({ tier, label: TIERS[tier], ...c })),
    majors: (majorsOf.get(String(p.id)) || [])
      .sort((a, b) => b.tier - a.tier || a.rank - b.rank),
    race: raceOf.get(String(p.id)) || { points: 0, events: 0, first: 0, second: 0, third: 0 },
  };
});
players.sort((a, b) => b.rating - a.rating);
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
  // Chess-style rule: provisional ratings are UNRANKED — the official ELO rank
  // counts established players only (keeps leaderboard and profile consistent
  // under any min-games filter).
  const ranked = inScope.filter((p) => !p.provisional); // rating-sorted already
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
const CONT_KEYS = new Set(Object.keys(CONTINENT_LABELS).map((k) => k.toLowerCase()));
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
  provisional: p.provisional, race: p.race,
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
const MAX_ROWS = Number(process.env.LEADERBOARD_MAX_ROWS || 2000);
for (const scope of allScopes) {
  const all = (scope === "global" ? publicPlayers : publicPlayers.filter((p) => p.scopes.includes(scope)));
  if (!all.length) continue;
  const rows = all.slice(0, MAX_ROWS).map(lbRow);
  for (const r of rows) leaderboardIds.add(r.id);
  writeFileSync(`site/leaderboards/${scope}.json`,
    JSON.stringify({ scope, generatedAt: new Date().toISOString(), totalPlayers: all.length, players: rows }));
  scopeMeta.push({ scope, players: all.length });
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
      return { id: m.id, oppId, oppHandle: playerById.get(oppId)?.handle || "?",
        result, date: m.date, eventId: m.eventId, eventName: events[m.eventId]?.name || "" };
    });
  const positions = (positionsOf.get(p.id) || []).slice()
    .sort((a, b) => scopeWeight(a.scope) - scopeWeight(b.scope) || a.scope.localeCompare(b.scope));
  writeFileSync(`site/players/${p.id}.json`, JSON.stringify({ ...p, positions, matches: ms }));
}
console.log(`players: ${profilePlayers.length} profile shards${PROFILE_SCOPES.length ? ` (scopes ${PROFILE_SCOPES.join(",")}; full set ${publicPlayers.length})` : ""}`);

// --- 4) search index: EVERY player with a profile shard (compact), so the
// search box finds anyone by nickname — the leaderboards are capped at the top
// rows, so without this a player ranked below the cap can't be found at all.
writeFileSync("site/leaderboards/search.json", JSON.stringify({
  generatedAt: new Date().toISOString(),
  players: profilePlayers.map((p) => ({ i: p.id, h: p.handle, r: p.rating, g: p.games, pr: p.provisional ? 1 : 0 })),
}));
console.log(`search index: ${profilePlayers.length} players`);
