// Build the catalog of Riftbound events in Sardinia to feed the ratings.
//
// Two sources, merged + deduped by event id:
//   1. PUBLIC feed sweep (/api/magic-events/) — recent + upcoming, ALL Sardinian
//      stores. The server ignores filters, so we sweep and filter client-side.
//      (The feed is a rolling window; it does NOT reach deep history.)
//   2. TOKEN: your own past registrations — deep history (back to launch) for the
//      stores you attend. For each such event we can later pull EVERY player's
//      matches, not just yours.
//
// Output: data/sardinian-events.json
//   [{ eventId, name, store, date, sources: ["feed"|"mine"] }, ...]
//
// Usage:  node --env-file=.env src/discover.mjs [maxPages]
//   (token optional but strongly recommended — it unlocks the history)

import {
  listEventsPage,
  getMyPastRegistrations,
  isRiftbound,
  isSardinian,
  isSardinianStore,
} from "./uvsgames.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

const MAX_PAGES = Number(process.argv[2] || process.env.MAX_PAGES || 80);
const PAGE_SIZE = 100;

/** eventId -> { eventId, name, store, date, sources:Set } */
const catalog = new Map();
function add(eventId, name, store, date, source) {
  if (eventId == null) return;
  const key = String(eventId);
  if (!catalog.has(key)) catalog.set(key, { eventId, name, store, date, sources: new Set() });
  catalog.get(key).sources.add(source);
}

// --- Source 1: public feed sweep ---
console.log(`Sweeping public events feed (max ${MAX_PAGES} pages of ${PAGE_SIZE})...`);
let page = 1;
let scanned = 0;
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
    add(e.id, e.name_pretty || e.name || "", e.store?.name || "", e.start_datetime || null, "feed");
  }
  if (!res.next) break;
  page++;
}
console.log(`  scanned ${scanned} events from feed.`);

// --- Source 2: my past registrations (deep history) ---
if (process.env.UVS_TOKEN) {
  try {
    const regs = await getMyPastRegistrations();
    let mine = 0;
    for (const r of regs) {
      const e = r.magic_event || {};
      if (!isSardinianStore(e.store)) continue;
      // past-registrations are the token user's own Riftbound events; keep all
      // (isRiftbound is lenient when game fields are absent on this shape)
      add(e.id, e.name_pretty || e.name || "", e.store?.name || "", e.start_datetime || null, "mine");
      mine++;
    }
    console.log(`  added ${mine} Sardinian event(s) from your past registrations.`);
  } catch (e) {
    console.error(`  past registrations skipped: ${e.message}`);
  }
} else {
  console.log("  (no UVS_TOKEN — skipping personal history; set it in .env to unlock deep history)");
}

// --- Output ---
const rows = [...catalog.values()]
  .map((r) => ({ ...r, sources: [...r.sources] }))
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));

console.log(`\n${rows.length} Sardinian Riftbound event(s):\n`);
const byStore = new Map();
for (const r of rows) {
  byStore.set(r.store, (byStore.get(r.store) || 0) + 1);
  console.log(
    `  ${String(r.eventId).padStart(7)}  ${(r.date || "").slice(0, 10)}  ${r.store.padEnd(24)}  ` +
      `${r.sources.join("+").padEnd(9)} ${r.name.slice(0, 36)}`
  );
}
console.log("\nBy store:");
for (const [s, c] of [...byStore.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${c}\t${s}`);

mkdirSync("data", { recursive: true });
writeFileSync("data/sardinian-events.json", JSON.stringify(rows, null, 2));
console.log(`\nWrote data/sardinian-events.json (${rows.length} events)`);
