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

// Storage occasionally throws transient 5xx during bulk uploads — retry before
// declaring failure (a single 502 once failed a whole otherwise-green run).
async function upload(key, body) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${base}/storage/v1/object/${BUCKET}/${key}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, apikey: KEY, "Content-Type": "application/json",
          "x-upsert": "true", "cache-control": "max-age=60" },
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
for (const path of walk("site")) {
  const key = relative("site", path).split("\\").join("/"); // e.g. leaderboards/it.json
  const body = readFileSync(path);
  const hash = createHash("sha1").update(body).digest("hex");
  next[key] = hash;
  if (manifest[key] === hash) { skipped++; continue; }
  if (await upload(key, body)) uploaded++;
  else { failed++; delete next[key]; } // retried next run via manifest miss
}
writeFileSync(MANIFEST, JSON.stringify(next));
console.log(`Published: ${uploaded} uploaded, ${skipped} unchanged, ${failed} failed -> bucket "${BUCKET}".`);
if (failed) process.exit(1);
