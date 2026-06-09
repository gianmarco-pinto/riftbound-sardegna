// Publish the generated rankings (site/data.json) to Supabase Storage so the
// website reads always-fresh data without redeploying.
//
// The site reads it from the public bucket; this uploads (upsert) the single
// JSON object. No tables/migrations needed.
//
// Required env (put in .env, NEVER commit the service key):
//   SUPABASE_URL=https://<project>.supabase.co
//   SUPABASE_SERVICE_KEY=<service_role key>     # write access; keep secret
// Optional:
//   SUPABASE_BUCKET=rankings   SUPABASE_OBJECT=sardegna.json
//
// One-time setup (in Supabase dashboard or via API): create a PUBLIC bucket
// named "rankings". Public read = anyone can fetch the JSON; only this script
// (with the service key) can write.
//
// Usage:  node --env-file=.env src/publish-supabase.mjs

import { readFileSync } from "node:fs";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = process.env.SUPABASE_BUCKET || "rankings";
const OBJECT = process.env.SUPABASE_OBJECT || "sardegna.json";

if (!URL || !KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY (see .env / .env.example).");
  process.exit(1);
}

const body = readFileSync("site/data.json");
const endpoint = `${URL.replace(/\/$/, "")}/storage/v1/object/${BUCKET}/${OBJECT}`;

const res = await fetch(endpoint, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${KEY}`,
    apikey: KEY,
    "Content-Type": "application/json",
    "x-upsert": "true",
    "cache-control": "max-age=60",
  },
  body,
});

if (!res.ok) {
  const t = await res.text().catch(() => "");
  console.error(`Upload failed: ${res.status} ${t.slice(0, 200)}`);
  process.exit(1);
}
console.log(`Published ${(body.length / 1024).toFixed(0)} KB -> ${BUCKET}/${OBJECT}`);
console.log(`Public URL: ${URL.replace(/\/$/, "")}/storage/v1/object/public/${BUCKET}/${OBJECT}`);
