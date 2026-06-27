// Probe v7: find the round-LIST endpoint + inspect a match fully (decks?). Read-only.
const TOKEN = (process.env.PROBE_TOKEN || "").trim();
if (!TOKEN) { console.error("::error::set PROBE_TOKEN"); process.exit(1); }
const auth = /^token\s/i.test(TOKEN) ? TOKEN.replace(/^token\s+/i, "Token ") : "Token " + TOKEN.replace(/^bearer\s+/i, "");
const RID = process.env.ROUND_ID || "836261", PH = process.env.PHASE_ID || "451707", id = (process.env.EVENT_IDS || "545120").split(",")[0].trim();
const H = "https://api.cloudflare.riftbound.uvsgames.com/hydraproxy/api/v2";
const headers = { Authorization: auth, accept: "application/json", Origin: "https://locator.riftbound.uvsgames.com", Referer: "https://locator.riftbound.uvsgames.com/" };
const get = async (u) => { try { const r = await fetch(`${H}/${u}`, { headers }); return { s: r.status, t: await r.text() }; } catch (e) { return { s: "ERR", t: e.message }; } };

console.log("=== round-LIST candidates (/paginated/ style) ===");
for (const p of [
  `tournament-phases/${PH}/tournament-rounds/paginated/?page=1&page_size=20`,
  `tournament-phases/${PH}/rounds/paginated/`,
  `events/${id}/tournament-rounds/paginated/`,
  `events/${id}/tournament-phases/${PH}/tournament-rounds/paginated/`,
  `tournament-rounds/paginated/?tournament_phase=${PH}&page=1&page_size=20`,
  `tournament-rounds/paginated/?event=${id}`,
  `tournament-phases/${PH}/tournament-rounds/`,
]) { const r = await get(p); let info = `${r.t.length}b`; if (r.s === 200) { try { const j = JSON.parse(r.t); const a = j.results || j; info += Array.isArray(a) ? ` array[${a.length}] firstKeys:${a[0] ? Object.keys(a[0]).slice(0, 8).join(",") : ""}` : " keys:" + Object.keys(j).slice(0, 8).join(","); } catch {} } console.log(`  ${r.s === 200 ? "✅" : r.s === 404 ? "  " : "❌"} ${String(r.s).padEnd(4)} ${p.padEnd(56)} ${r.s === 200 ? info : r.t.slice(0, 35).replace(/\s+/g, " ")}`); }

console.log("\n=== match detail (decks/legends? result?) ===");
const m = await get(`tournament-rounds/${RID}/matches/paginated/?page=1&page_size=2`);
if (m.s === 200) { try { const j = JSON.parse(m.t); const mm = (j.results || [])[0]; console.log(JSON.stringify(mm, null, 1).slice(0, 1500)); } catch { console.log(m.t.slice(0, 400)); } }
