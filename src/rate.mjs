// Glicko-2 rating engine. Reads matches from SQLite, writes current ratings +
// per-event rating snapshots back, and prints a leaderboard.
//
// Design:
//  - ONE GLOBAL rating per player. A regional board (e.g. --region Sardegna) is
//    just the global rating filtered to players who have played in that region.
//  - Rating period = one EVENT (tournament). Events processed chronologically.
//  - Snapshot after each event -> powers rating-over-time charts and
//    "best win / worst loss measured at the time".
//  - Inactivity decay: a player's RD (uncertainty) grows with weeks since their
//    last game, so stale ratings are flagged less confident. Rating value itself
//    is unchanged by inactivity (only certainty drops).
//
// Usage:
//   node src/rate.mjs                       # global leaderboard
//   node src/rate.mjs --region Sardegna     # players who've played in Sardegna
//   node src/rate.mjs --min-games 3 --top 30

import pkg from "glicko2";
const { Glicko2 } = pkg;
import {
  db, allRatedMatches, eventDates, clearRatings, upsertRating, insertSnapshot, transaction,
} from "./db.mjs";

const args = process.argv.slice(2);
const opt = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : def; };
const REGION = opt("--region", null);
const MIN_GAMES = Number(opt("--min-games", 1));
const TOP = Number(opt("--top", 40));
// Extra RD growth per sqrt(week) of inactivity ON TOP of the engine's own
// per-period growth. Defaults to 0: with weekly rating periods the engine
// already raises absent players' RD once per missed week (Glicko-2 step 6) —
// adding more would double-count inactivity.
const C_DECAY = Number(process.env.RD_DECAY_C || 0);

// --- league rules (env-overridable) ---
// A player is PROVISIONAL (visible but unranked) when ANY of:
//   - rating still uncertain (rd above threshold)
//   - fewer than 25 games played
//   - inactive for more than ~3 months
// Inactive players also lose DISPLAYED rating: after a grace period the shown
// ELO decays per week of inactivity (capped). The underlying skill estimate is
// untouched — play one event and the decay stops accruing.
const PROVISIONAL_RD = Number(process.env.PROVISIONAL_RD || 110);
const MIN_GAMES_ESTABLISHED = Number(process.env.MIN_GAMES_ESTABLISHED || 25);
const INACTIVE_PROVISIONAL_WEEKS = Number(process.env.INACTIVE_PROVISIONAL_WEEKS || 13); // ~3 months
const DECAY_GRACE_WEEKS = Number(process.env.DECAY_GRACE_WEEKS || 8);   // ~2 months untouched
const DECAY_PER_WEEK = Number(process.env.DECAY_PER_WEEK || 5);         // ELO points/week after grace
const DECAY_MAX = Number(process.env.DECAY_MAX || 150);                 // decay cap

const ranking = new Glicko2({ tau: 0.5, rating: 1500, rd: 350, vol: 0.06 });
const players = new Map(); // id -> glicko player
const meta = new Map();    // id -> stats
const getP = (id) => {
  if (!players.has(id)) {
    players.set(id, ranking.makePlayer());
    meta.set(id, { games: 0, wins: 0, losses: 0, draws: 0, lastDate: null });
  }
  return players.get(id);
};

// Group rated matches into WEEKLY rating periods (epoch-week buckets).
// One-period-per-event breaks at scale: the engine raises the RD of every
// absent player at each updateRatings() call, so with thousands of events
// (Italy-wide) everyone's RD exploded into "provisional". Weekly periods keep
// the call count proportional to TIME (~52/year), as Glicko-2 intends, and
// give the recommended 10-15 games per player per period.
const matches = allRatedMatches();
const evDate = eventDates();
const periodOf = (m) => {
  const t = Date.parse(evDate.get(m.eventId) ?? m.date ?? "");
  return Number.isNaN(t) ? -1 : Math.floor(t / 6048e5); // epoch week
};
const byPeriod = new Map();
for (const m of matches) {
  const k = periodOf(m);
  if (!byPeriod.has(k)) byPeriod.set(k, []);
  byPeriod.get(k).push(m);
}
const periods = [...byPeriod.keys()].sort((a, b) => a - b);

clearRatings();
transaction(() => {
  for (const pk of periods) {
    const period = [];
    const playedEvents = new Map(); // pid -> Set(eventId) within this week
    const mark = (pid, eid) => {
      let s = playedEvents.get(pid);
      if (!s) { s = new Set(); playedEvents.set(pid, s); }
      s.add(eid);
    };
    for (const m of byPeriod.get(pk)) {
      const A = getP(m.playerA), B = getP(m.playerB);
      const ma = meta.get(m.playerA), mb = meta.get(m.playerB);
      ma.games++; mb.games++;
      ma.lastDate = mb.lastDate = evDate.get(m.eventId);
      let outcome;
      if (m.winner === "A") { outcome = 1; ma.wins++; mb.losses++; }
      else if (m.winner === "B") { outcome = 0; mb.wins++; ma.losses++; }
      else { outcome = 0.5; ma.draws++; mb.draws++; }
      period.push([A, B, outcome]);
      mark(m.playerA, m.eventId); mark(m.playerB, m.eventId);
    }
    ranking.updateRatings(period);
    // snapshot the post-week rating against each event the player played
    for (const [pid, evs] of playedEvents) {
      const p = players.get(pid);
      for (const eid of evs) {
        insertSnapshot({
          player_id: pid, event_id: eid, date: evDate.get(eid),
          rating: Math.round(p.getRating()), rd: Math.round(p.getRd()), vol: +p.getVol().toFixed(4),
        });
      }
    }
  }

  // Final current ratings, with inactivity decay applied to RD only.
  // Reference time is clamped to NOW: events sometimes carry bogus FUTURE dates
  // (organizer typos, e.g. an October event with results in June) — using the
  // raw max event date once inflated everyone's RD into "provisional".
  const lastEvent = periods.length ? (periods[periods.length - 1] + 1) * 6048e5 : NaN;
  const latest = new Date(Math.min(Date.now(), Number.isNaN(lastEvent) ? Date.now() : lastEvent));
  for (const [id, p] of players) {
    const mt = meta.get(id);
    const weeks = mt.lastDate ? Math.max(0, (latest - new Date(mt.lastDate)) / 6048e5) : 0;
    const rd = Math.min(350, Math.sqrt(p.getRd() ** 2 + (C_DECAY ** 2) * weeks));
    const decay = Math.min(DECAY_MAX, Math.max(0, weeks - DECAY_GRACE_WEEKS) * DECAY_PER_WEEK);
    const provisional =
      rd > PROVISIONAL_RD ||
      mt.games < MIN_GAMES_ESTABLISHED ||
      weeks > INACTIVE_PROVISIONAL_WEEKS;
    upsertRating({
      player_id: id,
      rating: Math.round(p.getRating() - decay),
      rd: Math.round(rd),
      vol: +p.getVol().toFixed(4),
      games: mt.games, wins: mt.wins, losses: mt.losses, draws: mt.draws,
      last_date: mt.lastDate,
      provisional,
    });
  }
});

// --- leaderboard output ---
let sql = `
  SELECT r.player_id, COALESCE(p.handle,'?') AS handle, r.rating, r.rd,
         r.wins, r.losses, r.draws, r.games, r.provisional
  FROM ratings r JOIN players p ON p.id = r.player_id
  WHERE r.games >= ?`;
const params = [MIN_GAMES];
if (REGION) {
  sql += ` AND r.player_id IN (
    SELECT player_a FROM matches m JOIN events e ON e.id=m.event_id
      WHERE e.region LIKE ? OR e.country LIKE ? OR e.city LIKE ?
    UNION
    SELECT player_b FROM matches m JOIN events e ON e.id=m.event_id
      WHERE e.region LIKE ? OR e.country LIKE ? OR e.city LIKE ?)`;
  const like = `%${REGION}%`;
  params.push(like, like, like, like, like, like);
}
sql += ` ORDER BY r.rating DESC LIMIT ?`;
params.push(TOP);

const rows = db.prepare(sql).all(...params);
const scope = REGION ? `region~"${REGION}"` : "global";
console.log(`\nLeaderboard (${scope}, min ${MIN_GAMES} games, top ${TOP}) — ★ = provisional\n`);
console.log("  #  ELO   ±RD   W-L-D     G   Player");
rows.forEach((r, i) => {
  const flag = r.provisional ? "★" : " ";
  console.log(
    `${flag}${String(i + 1).padStart(2)}  ${String(r.rating).padStart(4)}  ±${String(r.rd).padStart(3)}  ` +
    `${`${r.wins}-${r.losses}-${r.draws}`.padEnd(8)} ${String(r.games).padStart(3)}  ${r.handle}`
  );
});
console.log("");
