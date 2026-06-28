// Thin data layer over SQLite (Node's built-in node:sqlite).
//
// WORLDWIDE-READY BY DESIGN:
//  - Every event stores its geography (country/region/city/lat/lng) so
//    leaderboards can be sliced at ANY level (store -> city -> region ->
//    country -> global) with a WHERE clause. "Sardinia" is never hardcoded.
//  - Player ratings are GLOBAL (one rating per player); regional boards are
//    filtered views of the same rating.
//  - All SQL is kept standard and funnelled through this one file, so swapping
//    SQLite -> Postgres later means rewriting only this module.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { ORGANIZER_STORE_IDS } from "./scopes.mjs";

mkdirSync("data", { recursive: true });

export const db = new DatabaseSync(process.env.DB_PATH || "data/riftbound.db");
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS stores (
  id      INTEGER PRIMARY KEY,
  name    TEXT,
  country TEXT,
  region  TEXT,
  city    TEXT,
  lat     REAL,
  lng     REAL
);

CREATE TABLE IF NOT EXISTS players (
  id         TEXT PRIMARY KEY,      -- platform player.id (globally stable)
  handle     TEXT,                  -- best_identifier; NO email/real name ever
  first_seen TEXT,
  last_seen  TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY,
  name      TEXT,
  store_id  INTEGER REFERENCES stores(id),
  date      TEXT,
  game      TEXT,
  country   TEXT,
  region    TEXT,
  city      TEXT,
  lat       REAL,
  lng       REAL
);

CREATE TABLE IF NOT EXISTS matches (
  id           INTEGER PRIMARY KEY,  -- matchId -> idempotent dedup
  event_id     INTEGER REFERENCES events(id),
  round_id     INTEGER,
  round_number INTEGER,
  tbl          INTEGER,
  date         TEXT,
  is_bye       INTEGER NOT NULL DEFAULT 0,
  player_a     TEXT,
  player_b     TEXT,
  winner       TEXT                  -- 'A' | 'B' | 'draw' | NULL
);
CREATE INDEX IF NOT EXISTS idx_matches_event ON matches(event_id);
CREATE INDEX IF NOT EXISTS idx_matches_pa ON matches(player_a);
CREATE INDEX IF NOT EXISTS idx_matches_pb ON matches(player_b);

CREATE TABLE IF NOT EXISTS ratings (
  player_id   TEXT PRIMARY KEY REFERENCES players(id),
  rating      REAL, rd REAL, vol REAL,
  games       INTEGER, wins INTEGER, losses INTEGER, draws INTEGER,
  last_date   TEXT,
  provisional INTEGER
);

CREATE TABLE IF NOT EXISTS rating_snapshots (
  player_id TEXT REFERENCES players(id),
  event_id  INTEGER REFERENCES events(id),
  date      TEXT,
  rating    REAL, rd REAL, vol REAL,
  PRIMARY KEY (player_id, event_id)
);

CREATE TABLE IF NOT EXISTS placements (
  event_id     INTEGER,
  player_id    TEXT,
  rank         INTEGER,
  participants INTEGER,
  PRIMARY KEY (event_id, player_id)
);
`);

// migration-lite: columns added after first release (no-op if present)
for (const sql of [
  "ALTER TABLE events ADD COLUMN continent TEXT",
  "ALTER TABLE events ADD COLUMN ingested_at TEXT",
  // W/L/D from the public registrations endpoint (results without exact pairings)
  "ALTER TABLE placements ADD COLUMN wins INTEGER",
  "ALTER TABLE placements ADD COLUMN losses INTEGER",
  "ALTER TABLE placements ADD COLUMN draws INTEGER",
  // when we last pulled this event's authoritative W/L/D from the registrations
  // endpoint. NULL = never (e.g. events ingested by the old pre-lockdown pipeline,
  // which only stored rank → W/L/D fell back to byes-blind match derivation).
  "ALTER TABLE events ADD COLUMN results_at TEXT",
  // UVS `display_status` (upcoming / in_progress / complete ...). We only ingest
  // results once it's "complete" — never process a tournament still running.
  "ALTER TABLE events ADD COLUMN status TEXT",
  // When we last pulled EXACT pairings for this event from the authenticated
  // hydraproxy backend (ingest-pairings). NULL = no real matches (rating uses the
  // Phase-B placement estimate); set = exact Glicko from real pairings. This is
  // how we tell "exact" events apart from "estimated" ones post-lockdown.
  "ALTER TABLE events ADD COLUMN pairings_at TEXT",
  // GAME counts per match (best-of-N: e.g. 2-1). The old pipeline stored only the
  // WINNER, not the game score; the hydraproxy pairings carry per-player games_won,
  // enabling GWP% (game win %) + the real Swiss tiebreakers. NULL on historical
  // (pre-lockdown) matches that predate this column.
  "ALTER TABLE matches ADD COLUMN games_a INTEGER",
  "ALTER TABLE matches ADD COLUMN games_b INTEGER",
]) { try { db.exec(sql); } catch { /* already there */ } }

// --- prepared upserts ---
const _store = db.prepare(`
  INSERT INTO stores (id,name,country,region,city,lat,lng)
  VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    name=excluded.name, country=excluded.country, region=excluded.region,
    city=excluded.city, lat=excluded.lat, lng=excluded.lng`);
export const upsertStore = (s) =>
  _store.run(s.id, s.name ?? null, s.country ?? null, s.region ?? null, s.city ?? null, s.lat ?? null, s.lng ?? null);

const _event = db.prepare(`
  INSERT INTO events (id,name,store_id,date,game,country,region,city,lat,lng,continent,status)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    name=excluded.name, store_id=excluded.store_id, date=excluded.date, game=excluded.game,
    country=excluded.country, region=excluded.region, city=excluded.city,
    lat=excluded.lat, lng=excluded.lng, continent=excluded.continent,
    status=COALESCE(excluded.status, events.status)`);
export const upsertEvent = (e) =>
  _event.run(e.id, e.name ?? null, e.store_id ?? null, e.date ?? null, e.game ?? null,
    e.country ?? null, e.region ?? null, e.city ?? null, e.lat ?? null, e.lng ?? null,
    e.continent ?? null, e.status ?? null);

// --- incremental ingestion state ---
export const markIngested = (id) =>
  db.prepare("UPDATE events SET ingested_at = ? WHERE id = ?").run(new Date().toISOString(), id);

// Stamp when EXACT pairings were pulled from the authenticated hydraproxy backend.
export const markPairings = (id) =>
  db.prepare("UPDATE events SET pairings_at = ? WHERE id = ?").run(new Date().toISOString(), id);

/** The post-lockdown GAP: concluded events we have standings for (placements)
 *  but NO exact pairings yet (matches absent AND pairings never pulled). These
 *  currently rely on the Phase-B estimate; pulling their real pairings upgrades
 *  them to exact Glicko. Bounded by a lockdown floor (no point re-pulling the
 *  pre-lockdown history — it already has real matches in the DB) and capped per
 *  run so it's resumable. Newest first (what people look at), with officials
 *  surfaced via the separate official refresh. */
export const eventsNeedingPairings = (limit, sinceDate) => db.prepare(`
  SELECT e.id, e.date, e.name FROM events e
  WHERE e.date >= ? AND e.pairings_at IS NULL
    AND EXISTS (SELECT 1 FROM placements p WHERE p.event_id = e.id)
    AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.event_id = e.id)
  ORDER BY
    CASE WHEN e.country = 'IT' THEN 0 ELSE 1 END,  -- project-core scope fills first
    e.date DESC                                     -- then newest first
  LIMIT ?`).all(sinceDate, limit);

/** Events whose matches were ingested by the OLD pipeline (winner only, no game
 *  score: games_a IS NULL) — re-pulling their pairings backfills the exact 2-1/0-2
 *  scores. NO date floor: covers ALL history. Self-limiting: pairings_at is stamped
 *  on (re)pull, so each event is attempted once even if no scores come back. IT +
 *  newest first so the project core and recent events fill before the long tail. */
export const eventsNeedingGameScores = (limit) => db.prepare(`
  SELECT e.id, e.date, e.name FROM events e
  WHERE e.pairings_at IS NULL
    AND EXISTS (SELECT 1 FROM matches m WHERE m.event_id = e.id AND m.is_bye = 0 AND m.games_a IS NULL)
  ORDER BY
    CASE WHEN e.country = 'IT' THEN 0 ELSE 1 END,
    e.date DESC
  LIMIT ?`).all(limit);

// Stamp when an event's authoritative W/L/D was fetched from registrations.
export const markResults = (id) =>
  db.prepare("UPDATE events SET results_at = ? WHERE id = ?").run(new Date().toISOString(), id);

/** Already-ingested events whose authoritative W/L/D needs a (re)fetch from the
 *  registrations endpoint: either never fetched (results_at NULL — the big
 *  pre-lockdown backfill) OR finished recently (re-fetched so late-finalized
 *  results / top-cut overwrite an intermediate capture). Newest first so the
 *  events people actually look at are corrected before the long tail. */
export const resultsToRefresh = (backfillLimit, freshDays) => {
  const now = new Date().toISOString();
  const freshCutoff = new Date(Date.now() - freshDays * 864e5).toISOString();
  // BACKFILL: events whose authoritative W/L/D was NEVER fetched (the ~140k old
  // pre-lockdown placements, results_at NULL). Newest first, with its OWN budget —
  // kept SEPARATE from the fresh re-check below so a busy recent window (often
  // >>backfillLimit events) can't starve the historical backfill (it did: a single
  // combined newest-first query never reached anything older than ~2 weeks).
  const backfill = db.prepare(`
    SELECT e.id, e.date FROM events e
    WHERE e.date < ? AND e.results_at IS NULL
      AND EXISTS (SELECT 1 FROM placements p WHERE p.event_id = e.id AND p.wins IS NULL)
    ORDER BY e.date DESC LIMIT ?`).all(now, backfillLimit);
  // FRESH: recently-finished events re-checked for a late finalization / correction.
  // Small window so it stays bounded and doesn't crowd out the backfill.
  const fresh = db.prepare(`
    SELECT e.id, e.date FROM events e
    WHERE e.date < ? AND e.date > ?
      AND EXISTS (SELECT 1 FROM placements p WHERE p.event_id = e.id)
    ORDER BY e.date DESC`).all(now, freshCutoff);
  const seen = new Set(backfill.map((e) => e.id));
  return [...backfill, ...fresh.filter((e) => !seen.has(e.id))];
};

/** Past events in enabled countries not yet ingested.
 *  countries = ["*"] disables the country gate (worldwide ingestion).
 *  Priority: ALREADY-LIVE scopes first (IT — the published site must stay
 *  fresh daily during the worldwide backfill), then the rest oldest-first.
 *  Ingestion order never affects ratings: rate.mjs always recomputes the
 *  full history in weekly periods. */
export const pendingEvents = (countries, limit) => {
  const worldwide = countries.length === 1 && countries[0] === "*";
  const gate = worldwide ? "" : `AND country IN (${countries.map(() => "?").join(",")})`;
  // Official-organizer events (RQ/Regional + their side events) first — these are
  // the high-value, low-count events that must enter the rankings ASAP, before the
  // long tail of local tournaments. Then Italy (already-live scope), then oldest.
  const official = ORGANIZER_STORE_IDS.length ? ORGANIZER_STORE_IDS.join(",") : "-1";
  return db.prepare(`
    SELECT id, name, date, country, region FROM events
    WHERE ingested_at IS NULL AND date < ? ${gate}
    ORDER BY
      CASE WHEN store_id IN (${official}) THEN 0 ELSE 1 END,
      CASE WHEN country = 'IT' THEN 0 ELSE 1 END,
      date ASC
    LIMIT ?`)
    .all(new Date().toISOString(), ...(worldwide ? [] : countries), limit);
};

// --- placements ---
const _placement = db.prepare(`
  INSERT INTO placements (event_id,player_id,rank,participants) VALUES (?,?,?,?)
  ON CONFLICT(event_id,player_id) DO UPDATE SET rank=excluded.rank, participants=excluded.participants`);
export const upsertPlacement = (eventId, playerId, rank, participants) =>
  _placement.run(eventId, playerId, rank, participants);

/** Ingested events that have matches but no placements yet (for standings fetch). */
export const eventsNeedingPlacements = (limit) => db.prepare(`
  SELECT DISTINCT e.id FROM events e
  JOIN matches m ON m.event_id = e.id
  WHERE NOT EXISTS (SELECT 1 FROM placements pl WHERE pl.event_id = e.id)
  ORDER BY e.date ASC LIMIT ?`).all(limit);

/** Official-organizer events (RQ/Regional) that are ingested — re-fetched every
 *  run so a final-standings update (top-cut) overwrites any intermediate-phase
 *  result captured while the event was still running. They are few. */
export const officialEventsToRefresh = (storeIds, limit) => {
  if (!storeIds.length) return [];
  return db.prepare(`
    SELECT DISTINCT e.id FROM events e
    JOIN matches m ON m.event_id = e.id
    WHERE e.store_id IN (${storeIds.map(() => "?").join(",")})
    ORDER BY e.date DESC LIMIT ?`).all(...storeIds, limit);
};

export const allPlacements = () => db.prepare(
  "SELECT event_id AS eventId, player_id AS playerId, rank, participants FROM placements").all();

const _player = db.prepare(`
  INSERT INTO players (id,handle,first_seen,last_seen)
  VALUES (?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    handle=COALESCE(excluded.handle, players.handle),
    first_seen=MIN(players.first_seen, excluded.first_seen),
    last_seen=MAX(players.last_seen, excluded.last_seen)`);
export const upsertPlayer = (id, handle, date) =>
  _player.run(id, handle && handle !== "Unknown" ? handle : null, date ?? null, date ?? null);

const _match = db.prepare(`
  INSERT INTO matches (id,event_id,round_id,round_number,tbl,date,is_bye,player_a,player_b,winner,games_a,games_b)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    event_id=excluded.event_id, round_id=excluded.round_id, round_number=excluded.round_number,
    tbl=excluded.tbl, date=excluded.date, is_bye=excluded.is_bye,
    player_a=excluded.player_a, player_b=excluded.player_b, winner=excluded.winner,
    games_a=COALESCE(excluded.games_a, matches.games_a),
    games_b=COALESCE(excluded.games_b, matches.games_b)`);
export const upsertMatch = (m) =>
  _match.run(m.matchId, m.eventId ?? null, m.roundId ?? null, m.roundNumber ?? null,
    m.table ?? null, m.date ?? null, m.isBye ? 1 : 0,
    m.playerA?.id ?? null, m.playerB?.id ?? null, m.winner ?? null,
    m.gamesA ?? null, m.gamesB ?? null);

// --- rating writers ---
export const clearRatings = () => { db.exec("DELETE FROM ratings; DELETE FROM rating_snapshots;"); };
const _rating = db.prepare(`
  INSERT INTO ratings (player_id,rating,rd,vol,games,wins,losses,draws,last_date,provisional)
  VALUES (?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(player_id) DO UPDATE SET
    rating=excluded.rating, rd=excluded.rd, vol=excluded.vol, games=excluded.games,
    wins=excluded.wins, losses=excluded.losses, draws=excluded.draws,
    last_date=excluded.last_date, provisional=excluded.provisional`);
export const upsertRating = (r) =>
  _rating.run(r.player_id, r.rating, r.rd, r.vol, r.games, r.wins, r.losses, r.draws, r.last_date, r.provisional ? 1 : 0);

const _snap = db.prepare(`
  INSERT INTO rating_snapshots (player_id,event_id,date,rating,rd,vol)
  VALUES (?,?,?,?,?,?)
  ON CONFLICT(player_id,event_id) DO UPDATE SET
    date=excluded.date, rating=excluded.rating, rd=excluded.rd, vol=excluded.vol`);
export const insertSnapshot = (s) => _snap.run(s.player_id, s.event_id, s.date, s.rating, s.rd, s.vol);

// --- readers ---
export const allRatedMatches = () => db.prepare(`
  SELECT id AS matchId, event_id AS eventId, round_number AS roundNumber, date,
         player_a AS playerA, player_b AS playerB, winner
  FROM matches
  WHERE is_bye = 0 AND winner IS NOT NULL AND player_a IS NOT NULL AND player_b IS NOT NULL
  ORDER BY date ASC, event_id ASC, round_number ASC`).all();

export const eventDates = () => {
  const rows = db.prepare("SELECT id, date FROM events").all();
  const m = new Map();
  for (const r of rows) m.set(r.id, r.date);
  return m;
};

export const transaction = (fn) => {
  db.exec("BEGIN");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { db.exec("ROLLBACK"); throw e; }
};
