// One-off FEASIBILITY PROBE (read-only): does a FRESH authenticated session get the
// exact pairings endpoint, or is it 403 for us too? Tests get_all_rounds on a few
// events that had rounds. Token comes from PROBE_TOKEN (never committed/printed).
//   PROBE_TOKEN="<hex or 'Token <hex>'>" [EVENT_IDS="id,id,..."] node src/probe-auth-pairings.mjs
const TOKEN = (process.env.PROBE_TOKEN || "").trim();
if (!TOKEN) { console.error("::error::set PROBE_TOKEN (a fresh logged-in session token)"); process.exit(1); }
const auth = /^token\s/i.test(TOKEN) ? TOKEN.replace(/^token\s+/i, "Token ") : "Token " + TOKEN.replace(/^bearer\s+/i, "");
const ids = (process.env.EVENT_IDS || "647366,692844,683264,702941").split(",").map((s) => s.trim()).filter(Boolean);

console.log(`probing get_all_rounds with a fresh token on ${ids.length} events...\n`);
let any200 = false;
for (const id of ids) {
  const url = `https://api.riftbound.uvsgames.com/api/magic-events/${id}/get_all_rounds/`;
  try {
    const r = await fetch(url, { headers: { Authorization: auth, accept: "application/json" } });
    const body = await r.text();
    if (r.status === 200) {
      any200 = true;
      let n = "?"; try { const j = JSON.parse(body); n = Array.isArray(j) ? j.length : (j.rounds?.length ?? Object.keys(j).length); } catch {}
      console.log(`event ${id}: HTTP 200 ✅  pairings ACCESSIBLE (${body.length} bytes, ~${n} rounds)`);
    } else {
      console.log(`event ${id}: HTTP ${r.status} ❌  ${body.slice(0, 100).replace(/\s+/g, " ")}`);
    }
  } catch (e) { console.log(`event ${id}: ERROR ${e.message}`); }
}
console.log("\n=== VERDICT ===");
console.log(any200
  ? "🟢 At least one 200 → pairings ARE accessible with this session. A live-tracker to recover real pairings is feasible."
  : "🔴 All non-200 → pairings remain gated for us even with a fresh login. Stick with Phase B (placement-based).");
