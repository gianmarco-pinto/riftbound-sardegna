// Watchdog: did UVS reopen the exact-pairings endpoint? It was locked ~2026-06-19
// (get_all_rounds → 403). Tests a few events that DEFINITELY had rounds (they have
// matches in our DB). If any returns 200, UVS likely reopened pairings → opens a
// GitHub issue (deduped) so we get notified to re-enable exact ingest (src/ingest.mjs).
// Non-failing.
import { db } from "./db.mjs";

const TOKEN = (process.env.UVS_TOKEN || "").trim();
const auth = TOKEN
  ? (/^token\s/i.test(TOKEN) ? TOKEN.replace(/^token\s+/i, "Token ") : "Token " + TOKEN.replace(/^bearer\s+/i, ""))
  : null;

// Events that historically had pairings (so a 200 means the endpoint truly works).
const evs = db.prepare("SELECT DISTINCT event_id id FROM matches ORDER BY event_id DESC LIMIT 5").all();
if (!evs.length) { console.log("probe: no event with matches to test"); process.exit(0); }

const ISSUE_TITLE = "🟢 UVS pairings endpoint reopened — re-enable exact ingest";

async function openIssue(eventId) {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!repo || !token) { console.log("(no GITHUB_REPOSITORY/token — skipping issue)"); return; }
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "riftladder-probe" };
  try {
    const open = await (await fetch(`https://api.github.com/repos/${repo}/issues?state=open&per_page=100`, { headers })).json();
    if (Array.isArray(open) && open.some((i) => i.title === ISSUE_TITLE)) { console.log("issue already open — not duplicating"); return; }
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST", headers,
      body: JSON.stringify({
        title: ISSUE_TITLE,
        body: `\`get_all_rounds\` returned **200** on event ${eventId} at ${new Date().toISOString()}.\n\nUVS may have reopened exact match pairings. To resume exact ELO + head-to-head, re-enable \`src/ingest.mjs\` (and \`resolve-nicknames.mjs\`) in \`.github/workflows/refresh.yml\` and let it backfill the gap since 2026-06-19.`,
      }),
    });
    console.log(res.ok ? "opened GitHub issue (pairings reopened)" : `issue POST failed: HTTP ${res.status}`);
  } catch (e) { console.log("issue alert failed:", e.message); }
}

let reopened = null;
for (const { id } of evs) {
  try {
    const r = await fetch(`https://api.riftbound.uvsgames.com/api/magic-events/${id}/get_all_rounds/`,
      { headers: auth ? { Authorization: auth } : {} });
    if (r.status === 200) { reopened = id; break; }
  } catch { /* ignore, try next */ }
}

if (reopened != null) {
  console.log(`::warning title=Pairings reopened::get_all_rounds returned 200 on event ${reopened} — re-enable src/ingest.mjs.`);
  console.log("🟢 PAIRINGS ENDPOINT REOPENED — resume exact-ELO ingest.");
  await openIssue(reopened);
} else {
  console.log(`pairings still locked (tested ${evs.length} events with matches; all non-200).`);
}
