// State shrink-guard — prevents the 2026-06 data-loss class of incident, where a
// run loaded a STALE/smaller DB (failed download -> fallback) and then overwrote
// the good state with it. Compares the loaded DB's row counts against the last
// known-good baseline (data/state-stats.json, persisted in the state release).
//
//   node src/state-guard.mjs check   -> run AFTER download, BEFORE discover/build.
//                                       Exits 1 if the DB shrank > (1-THRESH) vs
//                                       baseline (e.g. >20%) — abort the run so we
//                                       never build/publish/overwrite from bad state.
//   node src/state-guard.mjs update  -> run BEFORE upload-state. Writes the current
//                                       (good) counts as the new baseline.
//
// Override the threshold for a legitimate large drop: STATE_SHRINK_THRESH=0.5

import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const DB = "data/riftbound.db";
const STATS = "data/state-stats.json";
const THRESH = Number(process.env.STATE_SHRINK_THRESH || 0.8); // allow up to 20% shrink
const mode = process.argv[2];

function counts() {
  const db = new DatabaseSync(DB);
  const c = (t) => { try { return db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch { return 0; } };
  const r = { players: c("players"), matches: c("matches"), events: c("events"), placements: c("placements") };
  db.close();
  return r;
}

if (mode === "check") {
  if (!existsSync(DB)) { console.error("::error::state-guard: data/riftbound.db is missing — aborting"); process.exit(1); }
  const cur = counts();
  if (!existsSync(STATS)) { console.log("state-guard: no baseline yet (first run) — current", JSON.stringify(cur)); process.exit(0); }
  const base = JSON.parse(readFileSync(STATS, "utf8"));
  console.log("state-guard: baseline", JSON.stringify(base), "| current", JSON.stringify(cur));
  const watch = ["players", "matches", "placements"];
  const shrunk = watch.filter((k) => (base[k] || 0) > 0 && cur[k] < THRESH * base[k]);
  if (shrunk.length) {
    console.error(`::error::state-guard ABORT — ${shrunk.map((k) => `${k}=${cur[k]} (< ${Math.round(THRESH * 100)}% of last-good ${base[k]})`).join("; ")}. The loaded DB looks stale/corrupt; refusing to build/publish/overwrite good state. If this drop is legitimate, re-run with STATE_SHRINK_THRESH lowered.`);
    process.exit(1);
  }
  console.log("state-guard: OK — no significant shrink.");
} else if (mode === "update") {
  if (!existsSync(DB)) { console.error("state-guard update: DB missing, skipping"); process.exit(0); }
  const cur = counts();
  writeFileSync(STATS, JSON.stringify(cur));
  console.log("state-guard: baseline updated ->", JSON.stringify(cur));
} else {
  console.error("usage: state-guard.mjs check|update");
  process.exit(1);
}
