// Publish the generated site data (site/**) to Cloudflare R2 (S3 API) so the
// website reads always-fresh rankings without redeploys. Sharded-aware: walks
// site/ recursively and uploads only files whose content hash changed since the
// last publish (manifest kept in data/publish-manifest-r2.json).
//
// Why R2: the dataset is ~1.7GB of static JSON served to a public site. R2 gives
// 10GB storage free and ZERO egress fees (a CDN HIT in front of R2 costs nothing,
// and even origin reads are free egress) — it fixed both the egress overage and
// the Supabase 1GB storage limit. Auth/DB stay on Supabase; only this bucket moved.
//
// Required env: R2_ENDPOINT (https://<account>.r2.cloudflarestorage.com),
//   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
//
// NOTE on freshness: unlike Supabase's Smart CDN, Cloudflare in front of R2 does
// NOT auto-purge on overwrite — we rely purely on Cache-Control. The data refresh
// cadence is ~2h, so the short max-age below keeps staleness to minutes. Frozen
// players/events shards get a long max-age (they ~never change).
//
// Usage:  node --env-file=.env src/publish-r2.mjs

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { AwsClient } from "aws4fetch";

const ENDPOINT = (process.env.R2_ENDPOINT || "").replace(/\/$/, "");
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET = process.env.R2_BUCKET || "riftbound-rankings";
if (!ENDPOINT || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY) {
  console.error("Missing R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY.");
  process.exit(1);
}

const client = new AwsClient({
  accessKeyId: ACCESS_KEY_ID,
  secretAccessKey: SECRET_ACCESS_KEY,
  region: "auto",
  service: "s3",
});

// Separate manifest from the legacy Supabase one: R2 is a fresh destination, so
// the first run must upload everything (reusing the Supabase manifest would make
// it skip every file as "already uploaded").
const MANIFEST = "data/publish-manifest-r2.json";
let manifest = {};
try { manifest = JSON.parse(readFileSync(MANIFEST, "utf8")); } catch {}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith(".json")) yield p;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cache-Control per shard type. R2 has no auto-purge, so these govern freshness
// directly. players/ + events/ are frozen (never change) -> cache hard; the
// leaderboards/circuit shards refresh each run (~2h) -> short max-age.
function cacheControlFor(key) {
  if (key.startsWith("players/") || key.startsWith("events/"))
    return "public, max-age=3600, stale-while-revalidate=604800";
  return "public, max-age=600, stale-while-revalidate=86400";
}

async function upload(key, body) {
  const url = `${ENDPOINT}/${BUCKET}/${key}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await client.fetch(url, {
        method: "PUT",
        body,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": cacheControlFor(key),
        },
      });
      if (res.ok) return true;
      if (res.status < 500 && res.status !== 429) { // hard error: do not retry
        console.error(`  ✗ ${key}: ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`);
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
// Concurrent upload pool: 200k+ shards sequentially would blow the CI time limit.
const CONCURRENCY = Number(process.env.PUBLISH_CONCURRENCY || 12);
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
console.log(`Published: ${uploaded} uploaded, ${skipped} unchanged, ${failed} failed -> R2 bucket "${BUCKET}".`);

// A handful of files can still 5xx after retries under load. They're dropped from
// the manifest above, so the NEXT run retries exactly those — they self-heal.
const TOL = Number(process.env.PUBLISH_FAIL_TOLERANCE ?? 25);
if (failed > TOL) {
  console.error(`Too many failures (${failed} > tolerance ${TOL}) — failing the run.`);
  process.exit(1);
}
if (failed) console.log(`(${failed} transient failure(s) within tolerance — they'll retry next run.)`);
