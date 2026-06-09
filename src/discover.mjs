// Discover Riftbound events in Sardinia.
//
// The UVS events feed (/api/magic-events/) is PUBLIC but the server ignores
// game/region/geo query filters, so we page through it and filter client-side
// with isRiftbound() + isSardinian(). This is a broad sweep; for routine runs
// you can cap pages with MAX_PAGES (the feed is ordered roughly by date).
//
// Output: prints a table and writes data/sardinian-events.json
//   [{ eventId, name, store, region, city, date, status }, ...]
//
// Usage:  node src/discover.mjs [maxPages]
// (no token needed for discovery)

import { listEventsPage, isRiftbound, isSardinian } from "./uvsgames.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

const MAX_PAGES = Number(process.argv[2] || process.env.MAX_PAGES || 60);
const PAGE_SIZE = 100;

const found = [];
const seen = new Set();
let page = 1;
let scanned = 0;

console.log(`Sweeping UVS events feed (max ${MAX_PAGES} pages of ${PAGE_SIZE})...`);
for (let i = 0; i < MAX_PAGES; i++) {
  let res;
  try {
    res = await listEventsPage(page, PAGE_SIZE);
  } catch (e) {
    console.error(`  page ${page} failed: ${e.message}`);
    break;
  }
  scanned += res.results.length;
  for (const e of res.results) {
    if (!isRiftbound(e) || !isSardinian(e)) continue;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const s = e.store || {};
    found.push({
      eventId: e.id,
      name: e.name_pretty || e.name || "",
      store: s.name || "",
      region: s.administrative_area_level_1_short || "",
      city: (s.full_address || "").split(",").slice(-3, -2).join("").trim(),
      date: e.start_datetime || null,
      status: e.event_status || null,
    });
  }
  if (!res.next) break;
  page++;
}

found.sort((a, b) => String(a.date).localeCompare(String(b.date)));

console.log(`\nScanned ${scanned} events. Found ${found.length} Sardinian Riftbound event(s):\n`);
const stores = new Map();
for (const e of found) {
  stores.set(e.store, (stores.get(e.store) || 0) + 1);
  console.log(`  ${String(e.eventId).padStart(7)}  ${(e.date || "").slice(0, 10)}  ${e.store.padEnd(22)}  ${e.name.slice(0, 40)}`);
}
console.log(`\nStores: ${[...stores.entries()].map(([n, c]) => `${n} (${c})`).join(", ") || "none"}`);

mkdirSync("data", { recursive: true });
writeFileSync("data/sardinian-events.json", JSON.stringify(found, null, 2));
console.log("\nWrote data/sardinian-events.json");
