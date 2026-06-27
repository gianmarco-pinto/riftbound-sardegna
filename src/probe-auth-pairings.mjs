// Discovery probe: dump events/:id structure to find the rounds/pairings path,
// and try more candidates. Read-only. Token from PROBE_TOKEN.
const TOKEN = (process.env.PROBE_TOKEN || "").trim();
if (!TOKEN) { console.error("::error::set PROBE_TOKEN"); process.exit(1); }
const auth = /^token\s/i.test(TOKEN) ? TOKEN.replace(/^token\s+/i, "Token ") : "Token " + TOKEN.replace(/^bearer\s+/i, "");
const id = (process.env.EVENT_IDS || "545120").split(",")[0].trim();
const H = "https://api.cloudflare.riftbound.uvsgames.com/hydraproxy/api/v2";
const headers = { Authorization: auth, accept: "application/json", Origin: "https://locator.riftbound.uvsgames.com", Referer: "https://locator.riftbound.uvsgames.com/" };

async function get(url) { try { const r = await fetch(url, { headers }); const t = await r.text(); return { s: r.status, t }; } catch (e) { return { s: "ERR", t: e.message }; } }

console.log(`=== events/${id} full structure ===`);
const ev = await get(`${H}/events/${id}/`);
console.log("status", ev.s);
if (ev.s === 200) {
  try {
    const j = JSON.parse(ev.t);
    console.log("TOP KEYS:", Object.keys(j).join(", "));
    // print short scalars + array lengths + nested ids/urls that hint at sub-resources
    for (const [k, v] of Object.entries(j)) {
      if (v == null) continue;
      if (Array.isArray(v)) console.log(`  ${k}: array[${v.length}]` + (v[0] && typeof v[0] === "object" ? ` keys: ${Object.keys(v[0]).slice(0, 8).join(",")}` : ""));
      else if (typeof v === "object") console.log(`  ${k}: {${Object.keys(v).slice(0, 8).join(",")}}`);
      else if (/round|phase|pairing|standing|url|status|id|slug/i.test(k)) console.log(`  ${k}: ${String(v).slice(0, 80)}`);
    }
  } catch { console.log(ev.t.slice(0, 800)); }
}

const cands = [
  `events/${id}/phases/`, `events/${id}/players/`, `events/${id}/registrations/`,
  `events/${id}/current-round/`, `events/${id}/current_round/`, `events/${id}/matches/`,
  `event-players/?event=${id}`, `phases/?event=${id}`, `event-phases/?event=${id}`,
  `rounds/?event_id=${id}`, `pairings/?event_id=${id}`, `events/${id}/leaderboard/`,
];
console.log("\n=== candidate sub-resources ===");
for (const c of cands) {
  const r = await get(`${H}/${c}`);
  const mark = r.s === 200 ? "✅" : (r.s === 404 ? "  " : "❌");
  let info = `${r.t.length}b`;
  if (r.s === 200) { try { const j = JSON.parse(r.t); info += " " + (Array.isArray(j) ? `array[${j.length}]` : "keys:" + Object.keys(j).slice(0, 6).join(",")); } catch {} }
  console.log(`  ${mark} ${String(r.s).padEnd(4)} ${c.padEnd(34)} ${r.s === 200 ? info : r.t.slice(0, 60).replace(/\s+/g, " ")}`);
}
