// Ingest event RESULTS from the PUBLIC registrations endpoint — no token needed.
// UVS locked the exact-pairings endpoint (get_all_rounds, 403) ~2026-06-19, so we
// read aggregate results instead: /api/v2/events/<id>/registrations/ gives, per
// player: user.id (our stable id), nickname (best_identifier), W/L/D, points,
// final_place_in_standings. Enough to keep PLACEMENTS (→ Race, palmares) fresh.
//
// Incremental: finished events not yet results-ingested, newest first. (Historical
// W/L/D is NOT re-fetched — it's derived from the exact `matches` we already have,
// in build-site.) Concurrency keeps the per-event registration fetches quick.
import { db, upsertPlayer, markIngested, transaction } from "./db.mjs";

const BASE = "https://api.riftbound.uvsgames.com";
const MAX_EVENTS = Number(process.env.MAX_EVENTS || 12000);
const GIVE_UP_DAYS = Number(process.env.GIVE_UP_DAYS || 14);
const CONC = Number(process.env.INGEST_CONCURRENCY || 6);
const PAGE = 250;

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

const targets = db.prepare(`
  SELECT id, date FROM events
  WHERE ingested_at IS NULL AND date < datetime('now')
  ORDER BY date DESC LIMIT ?`).all(MAX_EVENTS);

console.log(`Ingest: up to ${targets.length} events (conc ${CONC})...`);
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
      if (placed > 0 || ageDays > GIVE_UP_DAYS) markIngested(ev.id);
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
