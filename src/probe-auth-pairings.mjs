// FEASIBILITY PROBE (read-only): with a fresh logged-in token, find the live
// pairings/rounds endpoint on the hydraproxy host. Token from PROBE_TOKEN.
//   PROBE_TOKEN="Token <hex>" [EVENT_IDS="545120,683264"] node src/probe-auth-pairings.mjs
const TOKEN = (process.env.PROBE_TOKEN || "").trim();
if (!TOKEN) { console.error("::error::set PROBE_TOKEN"); process.exit(1); }
const auth = /^token\s/i.test(TOKEN) ? TOKEN.replace(/^token\s+/i, "Token ") : "Token " + TOKEN.replace(/^bearer\s+/i, "");
const ids = (process.env.EVENT_IDS || "545120,683264").split(",").map((s) => s.trim()).filter(Boolean);

const HYDRA = "https://api.cloudflare.riftbound.uvsgames.com/hydraproxy/api/v2";
const OLD = "https://api.riftbound.uvsgames.com/api";
const headers = {
  Authorization: auth, accept: "application/json",
  Origin: "https://locator.riftbound.uvsgames.com", Referer: "https://locator.riftbound.uvsgames.com/",
};

async function hit(url) {
  try {
    const r = await fetch(url, { headers });
    const body = await r.text();
    let info = `${body.length}b`;
    if (r.ok) { try { const j = JSON.parse(body); info += " keys:" + (Array.isArray(j) ? `[${j.length}]` : Object.keys(j).slice(0, 6).join(",")); } catch {} }
    return { status: r.status, info, ok: r.ok, snippet: r.ok ? "" : body.slice(0, 80).replace(/\s+/g, " ") };
  } catch (e) { return { status: "ERR", info: e.message, ok: false }; }
}

console.log("=== token validity (event-configuration-templates, expect 200) ===");
{ const r = await hit(`${HYDRA}/event-configuration-templates/?game_slug=riftbound&is_active=true`);
  console.log(`  ${r.status}  ${r.info}`);
  if (r.status === 401 || r.status === 403) { console.log("::error::token invalid/expired — re-capture a fresh logged-in token."); } }

const paths = (id) => [
  [`${HYDRA}/events/${id}/`, "hydra events/:id"],
  [`${HYDRA}/events/${id}/rounds/`, "hydra events/:id/rounds"],
  [`${HYDRA}/events/${id}/pairings/`, "hydra events/:id/pairings"],
  [`${HYDRA}/events/${id}/standings/`, "hydra events/:id/standings"],
  [`${HYDRA}/events/${id}/get_all_rounds/`, "hydra events/:id/get_all_rounds"],
  [`${HYDRA}/magic-events/${id}/get_all_rounds/`, "hydra magic-events/:id/get_all_rounds"],
  [`${HYDRA}/magic-events/${id}/rounds/`, "hydra magic-events/:id/rounds"],
  [`${HYDRA}/event-rounds/?event=${id}`, "hydra event-rounds?event"],
  [`${HYDRA}/rounds/?event=${id}`, "hydra rounds?event"],
  [`${OLD}/magic-events/${id}/get_all_rounds/`, "OLD magic-events/:id/get_all_rounds"],
];

let found = [];
for (const id of ids) {
  console.log(`\n=== event ${id} ===`);
  for (const [url, label] of paths(id)) {
    const r = await hit(url);
    const mark = r.ok ? "✅" : (r.status === 404 ? "  " : "❌");
    console.log(`  ${mark} ${String(r.status).padEnd(4)} ${label.padEnd(34)} ${r.ok ? r.info : r.snippet}`);
    if (r.ok) found.push(`${label} (event ${id})`);
  }
}
console.log("\n=== VERDICT ===");
console.log(found.length
  ? "🟢 Working live endpoint(s):\n  - " + found.join("\n  - ") + "\n→ live-tracker is feasible; build against these."
  : "🔴 No pairings/rounds endpoint returned 200. Need the exact URL from the Network tab.");
