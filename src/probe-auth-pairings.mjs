// Discovery probe v5: event-level round/pairing candidates. Read-only.
const TOKEN = (process.env.PROBE_TOKEN || "").trim();
if (!TOKEN) { console.error("::error::set PROBE_TOKEN"); process.exit(1); }
const auth = /^token\s/i.test(TOKEN) ? TOKEN.replace(/^token\s+/i, "Token ") : "Token " + TOKEN.replace(/^bearer\s+/i, "");
const id = (process.env.EVENT_IDS || "545120").split(",")[0].trim();
const PH = process.env.PHASE_ID || "451707"; // Phase 1 (COMPLETE, 7 rounds) from prior probe
const H = "https://api.cloudflare.riftbound.uvsgames.com/hydraproxy/api/v2";
const headers = { Authorization: auth, accept: "application/json", Origin: "https://locator.riftbound.uvsgames.com", Referer: "https://locator.riftbound.uvsgames.com/" };
const probe = async (path) => {
  try { const r = await fetch(`${H}/${path}`, { headers }); const t = await r.text();
    let info = `${t.length}b`; if (r.status === 200) { try { const j = JSON.parse(t); info += " " + (Array.isArray(j) ? `array[${j.length}]` : "keys:" + Object.keys(j).slice(0, 8).join(",")); } catch {} }
    console.log(`  ${r.status === 200 ? "✅" : r.status === 404 ? "  " : "❌"} ${String(r.status).padEnd(4)} ${path.padEnd(48)} ${r.status === 200 ? info : t.slice(0, 45).replace(/\s+/g, " ")}`);
  } catch (e) { console.log(`  ERR  ${path}: ${e.message}`); }
};
console.log(`event ${id}, phase ${PH}`);
for (const p of [
  `tournament-rounds/?event=${id}`, `tournament-rounds/?magic_event=${id}`, `tournament-rounds/?event_id=${id}`,
  `events/${id}/tournament-rounds/`, `events/${id}/tournament-phases/`, `events/${id}/tournament_phases/`,
  `tournament-rounds/?phase_id=${PH}`, `tournament-rounds/?tournament_phase_id=${PH}`,
  `event-rounds/?tournament_phase=${PH}`, `match-pairings/?tournament_phase=${PH}`,
  `events/${id}/round/7/`, `events/${id}/rounds/7/`, `events/${id}/pairings/?round=7`,
  `pairings/?event=${id}`, `tournament-matches/?event=${id}`, `seatings/?event=${id}`,
  `events/${id}/results/`, `events/${id}/top-cut/`, `events/${id}/payout-leaderboards/`,
]) await probe(p);
