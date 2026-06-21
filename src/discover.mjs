// Discover Riftbound events for the enabled scope and store their metadata in
// SQLite (no match data yet — that's ingest.mjs, which is incremental).
//
// Sweeps the geo circles of DISCOVER_SCOPE (default "it"; "eu" for phase 2)
// via /api/v2/events/ (honours lat/lng/num_miles + game_slug + dates), dedupes
// across circles, and upserts events + stores with country/region/continent.
// Metadata for ALL countries found in the circles is kept (free progress
// toward wider scopes); ingestion gating happens later by INGEST_COUNTRIES.
//
// Usage:  node --env-file=.env src/discover.mjs          (token required)
//   env: DISCOVER_SCOPE=it|eu   DISCOVER_AFTER=2025-10-01

import { searchEventsGeo, searchEventsGlobal, searchEventsByStores, normalizeRegion } from "./uvsgames.mjs";
import { CIRCLES, continentOf, ORGANIZER_STORE_IDS, countryFromAddress } from "./scopes.mjs";
import { upsertStore, upsertEvent, transaction, db } from "./db.mjs";

const SCOPE = (process.env.DISCOVER_SCOPE || "it").toLowerCase();
// Full-history sweep by default; set DISCOVER_LOOKBACK_DAYS (e.g. 45) once the
// historical catalog is in the DB — routine runs then only sweep the recent
// window instead of re-paging the whole timeline every 2 hours.
const AFTER = process.env.DISCOVER_LOOKBACK_DAYS
  ? new Date(Date.now() - Number(process.env.DISCOVER_LOOKBACK_DAYS) * 864e5).toISOString()
  : (process.env.DISCOVER_AFTER || "2025-10-01T00:00:00Z"); // Riftbound launch
const BEFORE = new Date(Date.now() + 60 * 24 * 3600e3).toISOString(); // +60d of upcoming

const circles = SCOPE === "world" ? [] : CIRCLES[SCOPE];
if (!circles) { console.error(`Unknown DISCOVER_SCOPE "${SCOPE}" (have: world, ${Object.keys(CIRCLES).join(", ")})`); process.exit(1); }
if (!process.env.UVS_TOKEN) { console.error("UVS_TOKEN required."); process.exit(1); }

// Sweep per month-window per circle: keeps each query well under the
// pagination cap (dense EU circles can hold thousands of events per month).
function monthWindows(afterISO, beforeISO) {
  const out = [];
  let t = new Date(afterISO);
  const end = new Date(beforeISO);
  while (t < end) {
    const next = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1));
    out.push([t.toISOString(), (next < end ? next : end).toISOString()]);
    t = next;
  }
  return out;
}

const windows = monthWindows(AFTER, BEFORE);
const seen = new Map(); // eventId -> raw event

// World scope: one global month-windowed sweep, no geography.
// On failure the window is BISECTED: the API dies deterministically on some
// pages (a corrupt record mid-April kills page 38 every time), so halving the
// window until the poisoned slice is hours wide loses almost nothing instead
// of a whole month.
async function sweepWorldWindow(from, to, depth = 0) {
  try {
    const events = await searchEventsGlobal({ after: from, before: to });
    for (const e of events) if (!seen.has(e.id)) seen.set(e.id, e);
    if (depth === 0) console.log(`  world ${from.slice(0, 7)}: ${events.length} events (running total ${seen.size})`);
    return;
  } catch (e) {
    const span = Date.parse(to) - Date.parse(from);
    if (span <= 6 * 3600e3 || depth >= 8) {
      console.error(`  ! world slice ${from} -> ${to} unreadable (${e.message}) — skipped`);
      return;
    }
    const mid = new Date((Date.parse(from) + Date.parse(to)) / 2).toISOString();
    console.warn(`  ~ world window ${from.slice(0, 10)}..${to.slice(0, 10)} failed, bisecting`);
    await sweepWorldWindow(from, mid, depth + 1);
    await sweepWorldWindow(mid, to, depth + 1);
  }
}
if (SCOPE === "world") {
  for (const [from, to] of windows) await sweepWorldWindow(from, to);
}

for (const [i, c] of circles.entries()) {
  let circleTotal = 0, circleFresh = 0;
  for (const [from, to] of windows) {
    try {
      const events = await searchEventsGeo({
        lat: c.lat, lng: c.lng, miles: c.miles, after: from, before: to, pageSize: 100, maxPages: 60,
      });
      if (events.length >= 100 * 60) console.warn(`  ! window ${from.slice(0, 7)} circle ${i + 1} hit page cap — possible truncation`);
      circleTotal += events.length;
      for (const e of events) if (!seen.has(e.id)) { seen.set(e.id, e); circleFresh++; }
    } catch (e) {
      console.error(`  ! circle ${i + 1} window ${from.slice(0, 7)} failed (${e.message}) — skipped, retried next run`);
    }
  }
  console.log(`  circle ${i + 1}/${circles.length} (${c.lat},${c.lng} r${c.miles}mi): ${circleTotal} events across ${windows.length} months, ${circleFresh} new`);
}

let stores = 0, events = 0;
transaction(() => {
  const storeSeen = new Set();
  for (const e of seen.values()) {
    const s = e.store || {};
    const country = (s.country || "").toUpperCase() || null;
    const region = normalizeRegion(country, s.state ?? s.administrative_area_level_1_short ?? null);
    if (s.id != null && !storeSeen.has(s.id)) {
      upsertStore({ id: s.id, name: s.name ?? null, country, region, city: s.city ?? null,
        lat: typeof s.latitude === "number" ? s.latitude : null,
        lng: typeof s.longitude === "number" ? s.longitude : null });
      storeSeen.add(s.id); stores++;
    }
    upsertEvent({
      id: e.id, name: e.name_pretty || e.name || "", store_id: s.id ?? null,
      date: e.start_datetime || null, game: "riftbound",
      country, region, city: s.city ?? null,
      lat: typeof s.latitude === "number" ? s.latitude : null,
      lng: typeof s.longitude === "number" ? s.longitude : null,
      continent: continentOf(country),
      status: e.display_status ?? null,
    });
    events++;
  }
});

// --- Organizer sweep: official events (Regional Qualifiers, PAX, champs...) ---
// Their "store" has no coordinates (invisible to circles) and its country is
// the organizer's HQ (US), so the venue country is parsed from the EVENT
// address ("..., 40127 Bologna BO, Italy" -> IT).
let orgCount = 0;
try {
  const orgEvents = await searchEventsByStores(ORGANIZER_STORE_IDS, { after: AFTER, before: BEFORE });
  transaction(() => {
    for (const e of orgEvents) {
      const s = e.store || {};
      if (s.id != null) {
        upsertStore({ id: s.id, name: s.name ?? null, country: (s.country || "").toUpperCase() || null,
          region: null, city: null, lat: null, lng: null });
      }
      const venueCountry = countryFromAddress(e.event_address_override || e.full_address) ||
        (s.country || "").toUpperCase() || null;
      upsertEvent({
        id: e.id, name: e.name_pretty || e.name || "", store_id: s.id ?? null,
        date: e.start_datetime || null, game: "riftbound",
        country: venueCountry, region: null, city: null, lat: null, lng: null,
        continent: continentOf(venueCountry),
        status: e.display_status ?? null,
      });
      orgCount++;
    }
  });
  console.log(`Organizer sweep: ${orgEvents.length} official events upserted (stores: ${ORGANIZER_STORE_IDS.join(",")}).`);
} catch (e) {
  console.error(`Organizer sweep failed (non-fatal): ${e.message}`);
}

const byCountry = db.prepare(
  "SELECT country, COUNT(*) n FROM events GROUP BY country ORDER BY n DESC LIMIT 12").all();
console.log(`\nUpserted ${events} events / ${stores} stores (scope "${SCOPE}").`);
console.log("Events in DB by country:", byCountry.map((r) => `${r.country || "?"}:${r.n}`).join("  "));
const pend = db.prepare(
  "SELECT COUNT(*) n FROM events WHERE ingested_at IS NULL AND date < datetime('now')").get();
console.log(`Pending past events (any country): ${pend.n}`);
