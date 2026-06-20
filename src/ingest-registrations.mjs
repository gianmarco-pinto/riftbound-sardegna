// Ingest event RESULTS from the PUBLIC registrations endpoint — no token needed.
// UVS locked the exact-pairings endpoint (/api/magic-events/<id>/get_all_rounds/,
// 403) around 2026-06-19, so we can no longer read who-beat-whom. But
// /api/v2/events/<id>/registrations/ is public and returns, per player:
// user.id (our stable id), best_identifier, W/L/D, points, final_place_in_standings.
// That's enough to keep PLACEMENTS (→ Race board, palmares) fresh. The historical
// match-by-match data (→ ELO/Glicko, head-to-head) stays frozen but intact.
import { db, upsertPlayer, markIngested, transaction } from "./db.mjs";

// placement + W/L/D (registrations give aggregate records, not pairings)
const putPlacement = db.prepare(`
  INSERT INTO placements (event_id, player_id, rank, participants, wins, losses, draws)
  VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(event_id, player_id) DO UPDATE SET
    rank=excluded.rank, participants=excluded.participants,
    wins=excluded.wins, losses=excluded.losses, draws=excluded.draws`);

const BASE = "https://api.riftbound.uvsgames.com";
const MAX_EVENTS = Number(process.env.MAX_EVENTS || 12000);
const GIVE_UP_DAYS = Number(process.env.GIVE_UP_DAYS || 14);
const PAGE = 250;

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
    if (!j.next) break;
    page++;
    if (page > 200) break; // safety
  }
  return { rows: out, count };
}

// Finished events not yet results-ingested, newest first (recent data first).
const targets = db.prepare(`
  SELECT id, date FROM events
  WHERE ingested_at IS NULL AND date < datetime('now')
  ORDER BY date DESC LIMIT ?`).all(MAX_EVENTS);

console.log(`Ingesting registrations for up to ${targets.length} finished events...`);
let okEvents = 0, okPlacements = 0, empty = 0, errored = 0;

for (const ev of targets) {
  try {
    const { rows, count } = await fetchRegistrations(ev.id);
    const participants = count || rows.length;
    const ageDays = (Date.now() - Date.parse(ev.date)) / 864e5;
    let placed = 0;
    transaction(() => {
      for (const r of rows) {
        const pid = r.user?.id != null ? String(r.user.id) : null;
        if (!pid) continue;
        const handle = r.best_identifier || r.user?.best_identifier || null;
        upsertPlayer(pid, handle, ev.date);
        const place = r.final_place_in_standings;
        if (place != null) {
          putPlacement.run(ev.id, pid, place, participants, r.matches_won ?? 0, r.matches_lost ?? 0, r.matches_drawn ?? 0);
          placed++;
        }
      }
      // Mark done when results are in; otherwise leave for retry — but give up on
      // events older than GIVE_UP_DAYS (no standings will ever appear).
      if (placed > 0 || ageDays > GIVE_UP_DAYS) markIngested(ev.id);
    });
    okPlacements += placed;
    if (placed > 0) okEvents++; else empty++;
    if (okEvents % 200 === 0) console.log(`  ${okEvents} events, ${okPlacements} placements...`);
  } catch (e) {
    errored++;
    console.log(`  ✗ ${ev.id} (${String(ev.date).slice(0, 10)}): ${e.message}`);
  }
}

const totalPlacements = db.prepare("SELECT COUNT(*) c FROM placements").get().c;
console.log(`Done: ${okEvents} events ingested, ${okPlacements} placements added, ${empty} empty, ${errored} errored.`);
console.log(`DB total placements: ${totalPlacements}.`);
