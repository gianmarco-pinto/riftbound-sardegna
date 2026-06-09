// Build the catalog of ALL Riftbound events in Sardinia (not just yours).
//
// Primary source: /api/v2/events/ geographic search — the one endpoint that
// honours filters (lat/lng/radius + game_slug + date range). One query centered
// on Sardinia with a radius covering the whole island returns every event at
// every Sardinian store, past and future. (This same primitive scales
// worldwide: change the center/radius, or tile multiple centers.)
//
// We over-fetch with a generous radius (catches Corsica/France too) and then
// filter precisely to Sardinian stores by country+region.
//
// Output: data/sardinian-events.json + data/stores.json
// Usage:  node --env-file=.env src/discover.mjs        (token required)

import {
  searchEventsGeo, getMyPastRegistrations, isSardinianStore, normalizeRegion,
} from "./uvsgames.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

// Center + radius covering all of Sardinia (Cagliari + 200mi reaches Sassari,
// Oristano, etc.). Overridable for reuse elsewhere.
const LAT = Number(process.env.SARD_LAT || 40.0);   // central Sardinia
const LNG = Number(process.env.SARD_LNG || 9.0);
const MILES = Number(process.env.SARD_MILES || 250); // covers the whole island; region filter excludes mainland

const catalog = new Map();   // eventId -> row
const storesGeo = new Map(); // storeId -> geo

function recordStore(s) {
  if (!s || s.id == null) return;
  storesGeo.set(s.id, {
    id: s.id, name: s.name ?? null, country: s.country ?? null,
    region: normalizeRegion(s.country, s.state ?? s.administrative_area_level_1_short ?? null),
    city: s.city ?? null,
    lat: typeof s.latitude === "number" ? s.latitude : null,
    lng: typeof s.longitude === "number" ? s.longitude : null,
  });
}
function add(e, source) {
  if (e?.id == null) return;
  const key = String(e.id);
  if (!catalog.has(key)) {
    catalog.set(key, {
      eventId: e.id,
      name: e.name_pretty || e.name || "",
      store: e.store?.name || "",
      date: e.start_datetime || null,
      sources: new Set(),
    });
  }
  catalog.get(key).sources.add(source);
}

if (!process.env.UVS_TOKEN) {
  console.error("UVS_TOKEN required (the v2 geo search is authenticated). Set it in .env.");
  process.exit(1);
}

// --- Primary: geographic search ---
console.log(`Geo search: Riftbound within ${MILES}mi of (${LAT}, ${LNG})...`);
const events = await searchEventsGeo({ lat: LAT, lng: LNG, miles: MILES });
let kept = 0, dropped = 0;
for (const e of events) {
  if (!isSardinianStore(e.store)) { dropped++; continue; } // drop Corsica/France etc.
  recordStore(e.store);
  add(e, "geo");
  kept++;
}
console.log(`  ${events.length} events in radius -> ${kept} Sardinian, ${dropped} outside region.`);

// --- Safety net: your own past registrations (in case any fall outside radius) ---
try {
  const regs = await getMyPastRegistrations();
  let extra = 0;
  for (const r of regs) {
    const e = r.magic_event || {};
    if (!isSardinianStore(e.store)) continue;
    if (!catalog.has(String(e.id))) extra++;
    add(e, "mine");
  }
  if (extra) console.log(`  +${extra} extra event(s) from your history.`);
} catch (e) { console.error(`  past registrations skipped: ${e.message}`); }

// --- Output ---
const rows = [...catalog.values()]
  .map((r) => ({ ...r, sources: [...r.sources] }))
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));

const byStore = new Map();
for (const r of rows) byStore.set(r.store, (byStore.get(r.store) || 0) + 1);
console.log(`\n${rows.length} Sardinian Riftbound events across ${byStore.size} stores:`);
for (const [s, c] of [...byStore.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(3)}  ${s}`);

mkdirSync("data", { recursive: true });
writeFileSync("data/sardinian-events.json", JSON.stringify(rows, null, 2));
writeFileSync("data/stores.json", JSON.stringify([...storesGeo.values()], null, 2));
console.log(`\nWrote data/sardinian-events.json (${rows.length}) and data/stores.json (${storesGeo.size}).`);
