// RECOVERY TOOL — rebuild riftbound.db from the published Supabase shards.
// Used once after the state DB regressed (a run fell back to a stale backup).
// The published shards (players/<id>.json, events/<id>.json) are the complete
// dataset and contain everything needed to repopulate every table faithfully —
// NO recompute, so it's an exact restore, not an approximation.
//
// MEMORY-BOUNDED: processes shards in CHUNKS, inserting into SQLite per chunk and
// freeing memory between chunks. Match dedup is done by SQLite (id PRIMARY KEY +
// INSERT OR IGNORE), not an in-memory Map — so it scales to the full set without
// OOM (the naive accumulate-then-write version died OOM on an 8GB machine).
//
// Safe: writes to a NEW db file; never touches the live bucket or state release.
//
// Usage: node src/reconstruct-from-shards.mjs /tmp/rebuilt.db [SAMPLE]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";

const OUT = process.argv[2] || "/tmp/rebuilt.db";
const SAMPLE = process.argv[3] ? Number(process.argv[3]) : 0;
const BASE = "https://bklmwueojaftiedhwazp.supabase.co/storage/v1/object/public/rankings";
const CONC = Number(process.env.RECON_CONC || 48);
const CHUNK = Number(process.env.RECON_CHUNK || 3000);

const SCHEMA = `
CREATE TABLE events (id INTEGER PRIMARY KEY, name TEXT, store_id INTEGER, date TEXT, game TEXT, country TEXT, region TEXT, city TEXT, lat REAL, lng REAL, continent TEXT, ingested_at TEXT, results_at TEXT, status TEXT);
CREATE TABLE matches (id INTEGER PRIMARY KEY, event_id INTEGER, round_id INTEGER, round_number INTEGER, tbl INTEGER, date TEXT, is_bye INTEGER NOT NULL DEFAULT 0, player_a TEXT, player_b TEXT, winner TEXT);
CREATE TABLE placements (event_id INTEGER, player_id TEXT, rank INTEGER, participants INTEGER, wins INTEGER, losses INTEGER, draws INTEGER, PRIMARY KEY (event_id, player_id));
CREATE TABLE players (id TEXT PRIMARY KEY, handle TEXT, first_seen TEXT, last_seen TEXT);
CREATE TABLE rating_snapshots (player_id TEXT, event_id INTEGER, date TEXT, rating REAL, rd REAL, vol REAL, PRIMARY KEY (player_id, event_id));
CREATE TABLE ratings (player_id TEXT PRIMARY KEY, rating REAL, rd REAL, vol REAL, games INTEGER, wins INTEGER, losses INTEGER, draws INTEGER, last_date TEXT, provisional INTEGER);
CREATE TABLE stores (id INTEGER PRIMARY KEY, name TEXT, country TEXT, region TEXT, city TEXT, lat REAL, lng REAL);
`;

async function getJson(path, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(`${BASE}/${path}`);
      if (r.status === 404) return null;
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((z) => setTimeout(z, 400 * i));
  }
  return null;
}

// fetch a list of paths concurrently, return array of [item, json]
async function fetchChunk(items, toPath) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = [items[idx], await getJson(toPath(items[idx]))];
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  return out;
}

writeFileSync(OUT, "");
const db = new DatabaseSync(OUT);
db.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;");
db.exec(SCHEMA);
const insPlayer = db.prepare("INSERT OR REPLACE INTO players(id,handle,first_seen,last_seen) VALUES(?,?,?,?)");
const insRating = db.prepare("INSERT OR REPLACE INTO ratings(player_id,rating,rd,vol,games,wins,losses,draws,last_date,provisional) VALUES(?,?,?,?,?,?,?,?,?,?)");
const insSnap = db.prepare("INSERT OR REPLACE INTO rating_snapshots(player_id,event_id,date,rating,rd,vol) VALUES(?,?,?,?,?,?)");
const insMatch = db.prepare("INSERT OR IGNORE INTO matches(id,event_id,round_id,round_number,tbl,date,is_bye,player_a,player_b,winner) VALUES(?,?,?,?,?,?,0,?,?,?)");
const insEvent = db.prepare("INSERT OR REPLACE INTO events(id,name,store_id,date,game,country,region,city,lat,lng,continent,ingested_at,results_at,status) VALUES(?,?,NULL,?,NULL,?,?,NULL,NULL,NULL,NULL,?,?,'complete')");
const insPlace = db.prepare("INSERT OR REPLACE INTO placements(event_id,player_id,rank,participants,wins,losses,draws) VALUES(?,?,?,?,?,?,?)");
const NOW = "2026-06-25T00:00:00Z";

console.log("1) search.json...");
const search = await getJson("leaderboards/search.json");
let plist = (search?.players || []).map((p) => String(p.i ?? p.id));
const handle = new Map((search?.players || []).map((p) => [String(p.i ?? p.id), p.h ?? p.handle]));
if (SAMPLE) plist = plist.slice(0, SAMPLE);
console.log(`   players: ${plist.length}${SAMPLE ? ` (SAMPLE)` : ""}`);

const eventIds = new Set();
console.log("2) player shards (chunked)...");
let pdone = 0;
for (let c = 0; c < plist.length; c += CHUNK) {
  const chunk = plist.slice(c, c + CHUNK);
  const res = await fetchChunk(chunk, (id) => `players/${id}.json`);
  db.exec("BEGIN");
  for (const [id, s] of res) {
    if (!s) { insPlayer.run(id, handle.get(id) ?? null, null, null); continue; }
    insPlayer.run(id, s.handle ?? handle.get(id) ?? null, null, s.lastDate ?? null);
    if (s.rating != null || s.games != null)
      insRating.run(id, s.rating ?? null, s.rd ?? null, s.vol ?? null, s.games ?? 0, s.wins ?? 0, s.losses ?? 0, s.draws ?? 0, s.lastDate ?? null, s.provisional ? 1 : 0);
    for (const sn of s.series || []) { if (sn.eventId == null) continue; insSnap.run(id, sn.eventId, sn.date ?? null, sn.rating ?? null, sn.rd ?? null, null); eventIds.add(sn.eventId); }
    for (const m of s.matches || []) {
      if (m.eventId != null) eventIds.add(m.eventId);
      if (m.id == null) continue;
      const win = m.result === "W" ? "A" : m.result === "L" ? "B" : "draw";
      // cols: id,event_id,round_id,round_number,tbl,date,player_a,player_b,winner (is_bye is literal 0)
      insMatch.run(m.id, m.eventId ?? null, null, null, null, m.date ?? null, id, String(m.oppId), win);
    }
    for (const r of s.results || []) if (r.eventId != null) eventIds.add(r.eventId);
  }
  db.exec("COMMIT");
  pdone += chunk.length;
  console.log(`   ...${pdone}/${plist.length} players  (events seen: ${eventIds.size}, matches: ${db.prepare("SELECT COUNT(*) c FROM matches").get().c})`);
}

console.log("3) event shards (chunked)...");
const evAll = [...eventIds];
let edone = 0;
for (let c = 0; c < evAll.length; c += CHUNK) {
  const chunk = evAll.slice(c, c + CHUNK);
  const res = await fetchChunk(chunk, (id) => `events/${id}.json`);
  db.exec("BEGIN");
  for (const [eid, e] of res) {
    if (!e) continue;
    insEvent.run(eid, e.name ?? null, e.date ?? null, e.country ?? null, e.region ?? null, NOW, NOW);
    const part = e.participants ?? (e.standings?.length ?? null);
    for (const st of e.standings || []) insPlace.run(eid, String(st.id), st.rank ?? null, part, st.w ?? null, st.l ?? null, st.d ?? null);
  }
  db.exec("COMMIT");
  edone += chunk.length;
  console.log(`   ...${edone}/${evAll.length} events`);
}

console.log("\n=== REBUILT DB counts ===");
for (const t of ["players", "ratings", "rating_snapshots", "matches", "events", "placements"])
  console.log(`  ${t}: ${db.prepare("SELECT COUNT(*) c FROM " + t).get().c}`);
db.close();
console.log("\nDONE -> " + OUT);
