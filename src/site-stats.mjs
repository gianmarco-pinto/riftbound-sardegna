// Tiny post-build step: publish global aggregate counts for the homepage stat
// bar (players / matches / tournaments / stores / countries). Reads the DB,
// writes site/leaderboards/stats.json. Does NOT touch build-site.
import { db } from "./db.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

const c = (sql) => { try { return db.prepare(sql).get().c; } catch { return 0; } };
const stats = {
  generatedAt: new Date().toISOString(),
  players: c("SELECT COUNT(*) c FROM players"),
  matches: c("SELECT COUNT(*) c FROM matches"),
  tournaments: c("SELECT COUNT(DISTINCT event_id) c FROM placements"),
  stores: c("SELECT COUNT(*) c FROM stores"),
  countries: c("SELECT COUNT(DISTINCT country) c FROM events WHERE country IS NOT NULL AND country <> ''"),
};
const SITE = process.env.SITE_DIR || "site";
mkdirSync(`${SITE}/leaderboards`, { recursive: true });
writeFileSync(`${SITE}/leaderboards/stats.json`, JSON.stringify(stats));
console.log("site-stats:", JSON.stringify(stats));
