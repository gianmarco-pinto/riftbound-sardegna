// Ingest event RESULTS from the PUBLIC registrations endpoint — no token needed.
// UVS locked the exact-pairings endpoint (get_all_rounds, 403) ~2026-06-19, so we
// read aggregate results instead: /api/v2/events/<id>/registrations/ gives, per
// player: user.id (our stable id), nickname (best_identifier), W/L/D, points,
// final_place_in_standings. Enough to keep PLACEMENTS (→ Race, palmares) fresh.
//
// Incremental: finished events not yet results-ingested, newest first. (Historical
// W/L/D is NOT re-fetched — it's derived from the exact `matches` we already have,
// in build-site.) Concurrency keeps the per-event registration fetches quick.
import { db, upsertPlayer, markIngested, markResults, resultsToRefresh, emptyToRecheck, transaction } from "./db.mjs";

const BASE = "https://api.riftbound.uvsgames.com";
const MAX_EVENTS = Number(process.env.MAX_EVENTS || 12000);
const GIVE_UP_DAYS = Number(process.env.GIVE_UP_DAYS || 14);
const CONC = Number(process.env.INGEST_CONCURRENCY || 6);
const PAGE = 250;
// W/L/D backfill: how many already-ingested events to (re)pull authoritative
// records for per run, and how recently-finished events stay "fresh" (re-fetched
// every run so a late-finalized standing overwrites an intermediate capture).
const REFRESH_MAX = Number(process.env.REFRESH_MAX || 5000);
// Small fresh window (re-check recently-finished events for late finalization),
// kept SEPARATE from the backfill budget so it can't starve it. Was 21d, but a
// 3-week window holds >>5000 events worldwide and consumed the whole cap.
const FRESH_DAYS = Number(process.env.FRESH_DAYS || 3);
// Safety valve for the human factor: if an organizer forgets to mark an event
// "complete", ingest it anyway once it's this many days past its start (the
// standings are final the moment the rounds end — closing the event is just an
// admin flag). The ≤FRESH_DAYS re-refresh still corrects it if they close/edit later.
const FORCE_AFTER_DAYS = Number(process.env.FORCE_AFTER_DAYS || 5);
// Re-check recently-concluded EMPTY events (0 placements) for this many days, in
// case a store enters standings late (Nexus Night = an official tier, often filled
// a couple of days after). Runs on the refresh budget, not newTargets, so it can't
// starve fresh ingestion; short window so it doesn't re-scan empties forever.
const EMPTY_RECHECK_DAYS = Number(process.env.EMPTY_RECHECK_DAYS || 4);

const putPlacement = db.prepare(`
  INSERT INTO placements (event_id, player_id, rank, participants, wins, losses, draws)
  VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(event_id, player_id) DO UPDATE SET
    rank=excluded.rank, participants=excluded.participants,
    wins=excluded.wins, losses=excluded.losses, draws=excluded.draws`);

async function getJson(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((res) => setTimeout(res, 500 * (i + 1)));
    }
  }
}

async function fetchRegistrations(eventId) {
  const out = [];
  let page = 1, count = 0;
  while (true) {
    const j = await getJson(`${BASE}/api/v2/events/${eventId}/registrations/?page=${page}&page_size=${PAGE}`);
    if (!j) break;
    count = j.count ?? count;
    for (const r of j.results || []) out.push(r);
    if (!j.next || page > 200) break;
    page++;
  }
  return { rows: out, count };
}

// 1) NEW events (never ingested). 2) W/L/D (re)fresh of already-ingested events:
// backfills the ~140k old pre-lockdown placements that only had a rank (so their
// record stopped being byes-blind match guesses) and keeps recent events current.
// Only CONCLUDED tournaments: gate on UVS display_status = 'complete' so we never
// freeze an intermediate standing of a still-running event. Exceptions, OR'd in:
//  - status IS NULL  → transition fallback for events discovered before the column
//    (discover repopulates it each sweep; such events are also past-dated → done);
//  - date < forceCutoff → safety valve: an organizer who forgot to mark the event
//    complete shouldn't make us drop it forever — ingest it FORCE_AFTER_DAYS after
//    its start regardless of status.
const forceCutoff = new Date(Date.now() - FORCE_AFTER_DAYS * 864e5).toISOString();
const newTargets = db.prepare(`
  SELECT id, date FROM events
  WHERE ingested_at IS NULL AND date < datetime('now')
    AND (status = 'complete' OR status IS NULL OR date < ?)
  ORDER BY date DESC LIMIT ?`).all(forceCutoff, MAX_EVENTS);
const refreshTargets = resultsToRefresh(REFRESH_MAX, FRESH_DAYS);
const emptyTargets = emptyToRecheck(EMPTY_RECHECK_DAYS);
const seen = new Set(newTargets.map((e) => e.id));
const extra = [];
for (const e of [...refreshTargets, ...emptyTargets]) if (!seen.has(e.id)) { seen.add(e.id); extra.push(e); }
const targets = [...newTargets, ...extra];

console.log(`Ingest: ${newTargets.length} new + ${refreshTargets.length} W/L/D refresh + ${emptyTargets.length} empty-recheck = ${targets.length} events (conc ${CONC})...`);
let okEvents = 0, okPlacements = 0, empty = 0, errored = 0;

async function handle(ev) {
  try {
    const { rows, count } = await fetchRegistrations(ev.id);
    const participants = count || rows.length;
    const ageDays = (Date.now() - Date.parse(ev.date)) / 864e5;
    let placed = 0;
    transaction(() => {
      for (const r of rows) {
        const pid = r.user?.id != null ? String(r.user.id) : null;
        if (!pid) continue;
        upsertPlayer(pid, r.best_identifier || r.user?.best_identifier || null, ev.date);
        if (r.final_place_in_standings != null) {
          putPlacement.run(ev.id, pid, r.final_place_in_standings, participants, r.matches_won ?? 0, r.matches_lost ?? 0, r.matches_drawn ?? 0);
          placed++;
        }
      }
      // Mark done (stop re-listing in the primary newTargets queue) when we got
      // standings, OR the event is old enough to give up, OR the source confirms
      // it's EMPTY (0 registrations). An empty event would otherwise re-fetch every
      // run, burning the 800-event budget and starving real but slightly older
      // events at the bottom of the date-DESC queue. Late standings are NOT lost:
      // emptyToRecheck re-checks recently-concluded empties for EMPTY_RECHECK_DAYS
      // on the separate refresh budget (a Nexus Night filled 2-3 days late is caught).
      if (placed > 0 || ageDays > GIVE_UP_DAYS || participants === 0) markIngested(ev.id);
      markResults(ev.id); // stamp: authoritative W/L/D pulled (or confirmed absent)
    });
    okPlacements += placed;
    if (placed > 0) okEvents++; else empty++;
  } catch (e) {
    errored++;
    if (errored <= 20) console.log(`  ✗ ${ev.id} (${String(ev.date).slice(0, 10)}): ${e.message}`);
  }
}

// simple concurrency pool
let idx = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (idx < targets.length) {
    const ev = targets[idx++];
    await handle(ev);
    if ((okEvents + empty) % 500 === 0 && (okEvents + empty) > 0) console.log(`  ${okEvents} ok, ${empty} empty, ${okPlacements} placements...`);
  }
}));

console.log(`Done: ${okEvents} events, ${okPlacements} placements, ${empty} empty, ${errored} errored.`);
console.log(`DB total placements: ${db.prepare("SELECT COUNT(*) c FROM placements").get().c}.`);
