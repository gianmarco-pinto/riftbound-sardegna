// Publish the generated site data (site/**) to Supabase Storage so the website
// reads always-fresh rankings without redeploying. Sharded-aware: walks site/
// recursively and uploads only files whose content hash changed since the last
// publish (manifest kept in data/publish-manifest.json).
//
// Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY (secret!)
// Optional: SUPABASE_BUCKET=rankings
// One-time setup: create a PUBLIC bucket named "rankings".
//
// Usage:  node --env-file=.env src/publish-supabase.mjs

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";

// Accept the project URL in any pasted form (with/without /rest/v1/ etc.)
const URL = (process.env.SUPABASE_URL || "").replace(/\/(rest|storage|auth)\/v1\/?$/i, "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = process.env.SUPABASE_BUCKET || "rankings";
if (!URL || !KEY) { console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY."); process.exit(1); }

const MANIFEST = "data/publish-manifest.json";
let manifest = {};
try { manifest = JSON.parse(readFileSync(MANIFEST, "utf8")); } catch {}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith(".json")) yield p;
  }
}

const base = URL.replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cache-Control per shard type. Supabase's Smart CDN AUTO-PURGES an object on
// re-upload, so a long max-age is always fresh-on-update: between publishes the
// edge serves cached copies (a CDN HIT is NOT billed as egress), and the moment
// a changed file is re-uploaded the edge cache is invalidated. We only re-upload
// files whose content hash changed (manifest), so unchanged profiles/events stay
// edge-cached indefinitely. The old "max-age=60" + a per-minute client buster
// forced a full origin re-download on every page load and blew the egress quota.
//   - players/, events/  : huge count, rarely change -> cache hard (1h browser, swr 1w)
//   - everything else     : leaderboards/circuit refresh each run -> 10min browser, swr 1d
function cacheControlFor(key) {
  if (key.startsWith("players/") || key.startsWith("events/"))
    return "public, max-age=3600, stale-while-revalidate=604800";
  return "public, max-age=600, stale-while-revalidate=86400";
}

// Storage occasionally throws transient 5xx during bulk uploads — retry before
// declaring failure (a single 502 once failed a whole otherwise-green run).
async function upload(key, body) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${base}/storage/v1/object/${BUCKET}/${key}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, apikey: KEY, "Content-Type": "application/json",
          "x-upsert": "true", "cache-control": cacheControlFor(key) },
        body,
      });
      if (res.ok) return true;
      if (res.status < 500 && res.status !== 429) { // hard error: do not retry
        console.error(`  ✗ ${key}: ${res.status} ${(await res.text().catch(() => "")).slice(0, 120)}`);
        return false;
      }
      console.warn(`  ~ ${key}: ${res.status}, retry ${attempt}/4`);
    } catch (e) {
      console.warn(`  ~ ${key}: ${e.message}, retry ${attempt}/4`);
    }
    await sleep(1500 * attempt);
  }
  console.error(`  ✗ ${key}: still failing after retries`);
  return false;
}

let uploaded = 0, skipped = 0, failed = 0;
const next = {};
const queue = [];
for (const path of walk("site")) {
  const key = relative("site", path).split("\\").join("/"); // e.g. leaderboards/it.json
  const body = readFileSync(path);
  const hash = createHash("sha1").update(body).digest("hex");
  next[key] = hash;
  if (manifest[key] === hash) { skipped++; continue; }
  queue.push([key, body]);
}
// Concurrent upload pool: 100k+ profile shards sequentially would blow the CI
// time limit; 8 parallel streams keep it tractable.
const CONCURRENCY = Number(process.env.PUBLISH_CONCURRENCY || 8);
let cursor = 0;
async function worker() {
  for (;;) {
    const i = cursor++;
    if (i >= queue.length) return;
    const [key, body] = queue[i];
    if (await upload(key, body)) {
      uploaded++;
      if (uploaded % 1000 === 0) console.log(`  ...${uploaded}/${queue.length} uploaded`);
    } else { failed++; delete next[key]; } // retried next run via manifest miss
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
writeFileSync(MANIFEST, JSON.stringify(next));
console.log(`Published: ${uploaded} uploaded, ${skipped} unchanged, ${failed} failed -> bucket "${BUCKET}".`);
// A handful of files can still 5xx after all retries when Supabase Storage is
// under load (228k objects/run). They're dropped from the manifest above, so the
// NEXT run retries exactly those — they self-heal. Don't fail an otherwise-green
// run over a few transient timeouts (that just adds noise and can mask real
// outages); only fail if failures exceed a small tolerance, which signals a
// genuine problem (bad key, Storage down).
const TOL = Number(process.env.PUBLISH_FAIL_TOLERANCE ?? 25);
if (failed > TOL) {
  console.error(`Too many failures (${failed} > tolerance ${TOL}) — failing the run.`);
  process.exit(1);
}
if (failed) console.log(`(${failed} transient failure(s) within tolerance — they'll retry next run.)`);
