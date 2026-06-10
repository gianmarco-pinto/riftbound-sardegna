// Persist pipeline state between GitHub Actions runs via Supabase Storage.
// The SQLite DB + nickname map + publish manifest live in a PRIVATE bucket
// ("state"): downloaded at the start of a CI run, uploaded at the end.
// Locally you normally don't need this (state lives in data/).
//
// Usage:  node --env-file=.env src/state.mjs download
//         node --env-file=.env src/state.mjs upload
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, [SUPABASE_STATE_BUCKET=state]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const URL = (process.env.SUPABASE_URL || "").replace(/\/(rest|storage|auth)\/v1\/?$/i, "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = process.env.SUPABASE_STATE_BUCKET || "state";
const FILES = ["riftbound.db", "nicknames-resolved.json", "publish-manifest.json"];
const mode = process.argv[2];

if (!URL || !KEY) { console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY."); process.exit(1); }
if (!["download", "upload"].includes(mode)) { console.error("Usage: state.mjs download|upload"); process.exit(1); }

const base = URL.replace(/\/$/, "");
const H = { Authorization: `Bearer ${KEY}`, apikey: KEY };
mkdirSync("data", { recursive: true });

for (const f of FILES) {
  if (mode === "download") {
    const res = await fetch(`${base}/storage/v1/object/${BUCKET}/${f}`, { headers: H });
    if (res.status === 404 || res.status === 400) { console.log(`  ${f}: not in state yet (first run?)`); continue; }
    if (!res.ok) { console.error(`  ${f}: download failed ${res.status}`); process.exit(1); }
    writeFileSync(`data/${f}`, Buffer.from(await res.arrayBuffer()));
    console.log(`  ${f}: downloaded`);
  } else {
    if (!existsSync(`data/${f}`)) { console.log(`  ${f}: missing locally, skipped`); continue; }
    const res = await fetch(`${base}/storage/v1/object/${BUCKET}/${f}`, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/octet-stream", "x-upsert": "true" },
      body: readFileSync(`data/${f}`),
    });
    if (!res.ok) { console.error(`  ${f}: upload failed ${res.status} ${(await res.text().catch(() => "")).slice(0, 120)}`); process.exit(1); }
    console.log(`  ${f}: uploaded`);
  }
}
console.log(`State ${mode} complete (bucket "${BUCKET}").`);
