// Watchdog: did UVS reopen the exact-pairings endpoint? It was locked ~2026-06-19
// (get_all_rounds → 403). If it ever returns 200 again we can resume exact-ELO
// ingestion (src/ingest.mjs). Non-failing; emits a loud GitHub annotation if open.
import { db } from "./db.mjs";

const TOKEN = (process.env.UVS_TOKEN || "").trim();
const auth = TOKEN
  ? (/^token\s/i.test(TOKEN) ? TOKEN.replace(/^token\s+/i, "Token ") : "Token " + TOKEN.replace(/^bearer\s+/i, ""))
  : null;

const ev = db.prepare("SELECT id FROM events WHERE date < datetime('now') ORDER BY date DESC LIMIT 1").get();
if (!ev) { console.log("probe: no event to test"); process.exit(0); }

try {
  const r = await fetch(`https://api.riftbound.uvsgames.com/api/magic-events/${ev.id}/get_all_rounds/`,
    { headers: auth ? { Authorization: auth } : {} });
  if (r.status === 200) {
    console.log(`::warning title=Pairings reopened::get_all_rounds returned 200 on event ${ev.id} — UVS may have reopened exact pairings. Re-enable src/ingest.mjs.`);
    console.log("🟢 PAIRINGS ENDPOINT REOPENED — resume exact-ELO ingest.");
  } else {
    console.log(`pairings still locked: HTTP ${r.status} on get_all_rounds (event ${ev.id}).`);
  }
} catch (e) {
  console.log(`probe error (non-fatal): ${e.message}`);
}
