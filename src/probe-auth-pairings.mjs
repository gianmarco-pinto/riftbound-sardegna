// Discovery probe v6: CONFIRM pairings endpoint + find how to list rounds.
// tournament-rounds/<rid>/matches/paginated/ is the pairings call. Read-only.
const TOKEN = (process.env.PROBE_TOKEN || "").trim();
if (!TOKEN) { console.error("::error::set PROBE_TOKEN"); process.exit(1); }
const auth = /^token\s/i.test(TOKEN) ? TOKEN.replace(/^token\s+/i, "Token ") : "Token " + TOKEN.replace(/^bearer\s+/i, "");
const RID = process.env.ROUND_ID || "836261";
const PH = process.env.PHASE_ID || "451707";
const id = (process.env.EVENT_IDS || "545120").split(",")[0].trim();
const H = "https://api.cloudflare.riftbound.uvsgames.com/hydraproxy/api/v2";
const headers = { Authorization: auth, accept: "application/json", Origin: "https://locator.riftbound.uvsgames.com", Referer: "https://locator.riftbound.uvsgames.com/" };
const get = async (u) => { try { const r = await fetch(`${H}/${u}`, { headers }); return { s: r.status, t: await r.text() }; } catch (e) { return { s: "ERR", t: e.message }; } };
const tag = (s) => s === 200 ? "✅" : s === 404 ? "  " : "❌";

console.log("=== PAIRINGS (the goal) ===");
const m = await get(`tournament-rounds/${RID}/matches/paginated/?page=1&page_size=64&avoid_cache=false`);
console.log(`tournament-rounds/${RID}/matches/paginated/ → ${m.s}`);
if (m.s === 200) {
  try {
    const j = JSON.parse(m.t);
    console.log("envelope keys:", Object.keys(j).join(","));
    const arr = j.results || j.data || (Array.isArray(j) ? j : []);
    console.log("matches in page:", arr.length, "| total:", j.total ?? j.count ?? "?");
    if (arr[0]) {
      console.log("MATCH[0] keys:", Object.keys(arr[0]).join(","));
      console.log("MATCH[0] sample:", JSON.stringify(arr[0]).slice(0, 600));
    }
  } catch { console.log(m.t.slice(0, 300)); }
}

console.log("\n=== round detail (to learn relations) ===");
const rd = await get(`tournament-rounds/${RID}/`);
console.log(`tournament-rounds/${RID}/ → ${rd.s}`);
if (rd.s === 200) { try { const j = JSON.parse(rd.t); console.log("keys:", Object.keys(j).join(",")); console.log("vals:", JSON.stringify(j).slice(0, 500)); } catch {} }

console.log("\n=== how to LIST rounds of a phase ===");
for (const p of [
  `tournament-phases/${PH}/tournament-rounds/`, `tournament-phases/${PH}/`,
  `tournament-rounds/?tournament_phase=${PH}&page=1&page_size=20`,
  `tournament-rounds/paginated/?tournament_phase=${PH}`,
  `tournament-phases/${PH}/matches/paginated/`,
  `events/${id}/standings/paginated/`, `tournament-phases/${PH}/standings/paginated/`,
]) { const r = await get(p); let info = `${r.t.length}b`; if (r.s === 200) { try { const j = JSON.parse(r.t); info += " " + (Array.isArray(j) ? `array[${j.length}]` : "keys:" + Object.keys(j).slice(0, 6).join(",")); } catch {} } console.log(`  ${tag(r.s)} ${String(r.s).padEnd(4)} ${p.padEnd(46)} ${r.s === 200 ? info : r.t.slice(0, 40).replace(/\s+/g, " ")}`); }
