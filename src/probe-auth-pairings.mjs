// Discovery probe v4: pairings live under tournament_phases[].id. Extract phase ids,
// then probe phase/round/pairing resources. Read-only. PROBE_TOKEN required.
const TOKEN = (process.env.PROBE_TOKEN || "").trim();
if (!TOKEN) { console.error("::error::set PROBE_TOKEN"); process.exit(1); }
const auth = /^token\s/i.test(TOKEN) ? TOKEN.replace(/^token\s+/i, "Token ") : "Token " + TOKEN.replace(/^bearer\s+/i, "");
const id = (process.env.EVENT_IDS || "545120").split(",")[0].trim();
const H = "https://api.cloudflare.riftbound.uvsgames.com/hydraproxy/api/v2";
const headers = { Authorization: auth, accept: "application/json", Origin: "https://locator.riftbound.uvsgames.com", Referer: "https://locator.riftbound.uvsgames.com/" };
const get = async (u) => { try { const r = await fetch(u, { headers }); return { s: r.status, t: await r.text() }; } catch (e) { return { s: "ERR", t: e.message }; } };
const probe = async (label, path) => {
  const r = await get(`${H}/${path}`);
  let info = `${r.t.length}b`, j = null;
  if (r.s === 200) { try { j = JSON.parse(r.t); info += " " + (Array.isArray(j) ? `array[${j.length}]` : "keys:" + Object.keys(j).slice(0, 8).join(",")); } catch {} }
  console.log(`  ${r.s === 200 ? "✅" : r.s === 404 ? "  " : "❌"} ${String(r.s).padEnd(4)} ${path.padEnd(46)} ${r.s === 200 ? info : r.t.slice(0, 50).replace(/\s+/g, " ")}`);
  return { s: r.s, j };
};

const ev = await get(`${H}/events/${id}/`);
const phases = (() => { try { return JSON.parse(ev.t).tournament_phases || []; } catch { return []; } })();
console.log("phases:", phases.map((p) => `${p.id} (${p.phase_name}, ${p.status}, rounds=${p.number_of_rounds})`).join(" | ") || "none");
const pid = phases.length ? phases[phases.length - 1].id : null;
if (!pid) { console.log("no phase id — abort"); process.exit(0); }

console.log(`\n=== phase ${pid} sub-resources ===`);
let roundsJson = null;
for (const [lab, path] of [
  ["phase", `tournament-phases/${pid}/`],
  ["phase rounds", `tournament-phases/${pid}/rounds/`],
  ["phase pairings", `tournament-phases/${pid}/pairings/`],
  ["phase standings", `tournament-phases/${pid}/standings/`],
  ["rounds?tournament_phase", `tournament-rounds/?tournament_phase=${pid}`],
  ["rounds?phase", `tournament-rounds/?phase=${pid}`],
  ["rounds q phase", `rounds/?tournament_phase=${pid}`],
  ["phases/:id/rounds", `phases/${pid}/rounds/`],
]) { const r = await probe(lab, path); if (r.s === 200 && r.j && (Array.isArray(r.j) ? r.j.length : (r.j.results || r.j.rounds))) roundsJson = r.j; }

// if we found rounds, grab a round id and probe pairings under it
const rounds = roundsJson ? (Array.isArray(roundsJson) ? roundsJson : (roundsJson.results || roundsJson.rounds || [])) : [];
if (rounds.length) {
  const r0 = rounds.find((x) => x.id) || rounds[0];
  console.log(`\nround sample keys: ${Object.keys(r0).slice(0, 12).join(",")}`);
  const rid = r0.id;
  console.log(`\n=== round ${rid} pairings ===`);
  for (const path of [
    `tournament-rounds/${rid}/`, `tournament-rounds/${rid}/pairings/`,
    `tournament-rounds/${rid}/matches/`, `pairings/?tournament_round=${rid}`,
    `tournament-matches/?tournament_round=${rid}`, `tournament-matches/?round=${rid}`,
  ]) await probe("", path);
} else {
  console.log("\n(no rounds list found yet — see which phase path returned data above)");
}
