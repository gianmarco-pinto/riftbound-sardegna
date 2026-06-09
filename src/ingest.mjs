// Ingest events -> rounds -> matches into SQLite. Idempotent (dedup by matchId),
// so it can be re-run to accumulate. PII is dropped inside normalize.mjs.
//
// Usage:
//   node --env-file=.env src/ingest.mjs                 # ingest data/sardinian-events.json
//   node --env-file=.env src/ingest.mjs 198113 295467   # ingest specific event ids
//
// Worldwide note: this is geography-agnostic — it stores whatever events you
// feed it, tagging each with its store's location. Point it at a global catalog
// (instead of the Sardinian one) and the same code scales up.

import { readFileSync } from "node:fs";
import { getEvent, getEventRoundIds, getRoundMatches } from "./uvsgames.mjs";
import { matchToCanonical } from "./normalize.mjs";
import { upsertStore, upsertEvent, upsertPlayer, upsertMatch, transaction } from "./db.mjs";

// Store-geo cache built by discover.mjs (the event DETAIL endpoint returns a
// stripped store with no geo; the feed is the only place geo is exposed).
let storesCache = new Map();
try {
  const arr = JSON.parse(readFileSync("data/stores.json", "utf8"));
  storesCache = new Map(arr.map((s) => [s.id, s]));
  console.log(`Loaded geo for ${storesCache.size} stores.`);
} catch {
  console.warn("data/stores.json not found — events will have country only. Run discover.mjs to enrich geo.");
}

function parseCity(fullAddress) {
  if (!fullAddress) return null;
  const parts = fullAddress.split(",").map((p) => p.trim()).filter(Boolean);
  // typical: "<street>, <city>, <region>, <zip>, <country>"  -> city = parts[-4]
  return parts.length >= 4 ? parts[parts.length - 4] : (parts[1] || null);
}

function eventGeo(store) {
  const s = store || {};
  return {
    country: s.country ?? null,
    region: s.administrative_area_level_1_short ?? null,
    city: parseCity(s.full_address),
    lat: typeof s.latitude === "number" ? s.latitude : null,
    lng: typeof s.longitude === "number" ? s.longitude : null,
  };
}

async function ingestEvent(eventId) {
  const ev = await getEvent(eventId);
  const s = ev.store || {};
  // Prefer cached feed geo (rich); fall back to the detail store (country-only).
  const cached = s.id != null ? storesCache.get(s.id) : null;
  const geo = cached
    ? { country: cached.country ?? s.country ?? null, region: cached.region, city: cached.city, lat: cached.lat, lng: cached.lng }
    : eventGeo(s);
  const date = ev.start_datetime || null;
  const name = ev.name_pretty || ev.name || "";

  // pull all matches first (network), then write in one transaction
  const canon = [];
  const roundIds = await getEventRoundIds(eventId);
  for (const rid of roundIds) {
    let rd;
    try { rd = await getRoundMatches(rid); } catch (e) { console.error(`    round ${rid}: ${e.message}`); continue; }
    for (const m of rd.matches || []) {
      const c = matchToCanonical(m, { eventId, roundId: rid, roundNumber: rd.round_number, date });
      if (c) canon.push(c);
    }
  }

  let players = 0, matches = 0;
  transaction(() => {
    if (s.id != null) upsertStore({ id: s.id, name: s.name, ...geo });
    upsertEvent({ id: ev.id, name, store_id: s.id ?? null, date, game: "riftbound", ...geo });
    for (const c of canon) {
      if (c.playerA?.id) { upsertPlayer(c.playerA.id, c.playerA.name, date); players++; }
      if (c.playerB?.id) { upsertPlayer(c.playerB.id, c.playerB.name, date); players++; }
      upsertMatch(c); matches++;
    }
  });
  return { name, date, store: s.name, rounds: roundIds.length, matches };
}

// --- resolve which events to ingest ---
let ids = process.argv.slice(2).map(Number).filter(Boolean);
if (ids.length === 0) {
  try {
    const cat = JSON.parse(readFileSync("data/sardinian-events.json", "utf8"));
    ids = cat.map((e) => e.eventId);
  } catch {
    console.error("No event ids given and data/sardinian-events.json not found. Run discover.mjs first.");
    process.exit(1);
  }
}

console.log(`Ingesting ${ids.length} event(s)...\n`);
let okMatches = 0, okEvents = 0;
for (const id of ids) {
  try {
    const r = await ingestEvent(id);
    okEvents++; okMatches += r.matches;
    console.log(`  ✓ ${String(id).padStart(7)} ${(r.date || "").slice(0, 10)} ${(r.store || "").padEnd(22)} ${r.matches} matches  ${r.name.slice(0, 30)}`);
  } catch (e) {
    console.error(`  ✗ ${id}: ${e.message}`);
  }
}
console.log(`\nDone. ${okEvents}/${ids.length} events, ${okMatches} matches written to data/riftbound.db`);
