// Authenticated client for the LIVE tournament backend that powers the locator
// website itself: api.cloudflare.riftbound.uvsgames.com/hydraproxy (Carde.io).
//
// WHY THIS EXISTS: the OLD public/anonymous pairings endpoint
// (api.riftbound.uvsgames.com/.../get_all_rounds/) was locked to the public
// (403, permanent) ~2026-06-19, so the pipeline lost exact pairings. This host
// is the SAME backend the logged-in website uses; it still serves full pairings
// (live AND for concluded events) to any valid session token. Same data, just
// behind login instead of anonymous. See uvsgames.mjs for the dead endpoint.
//
// AUTH: Authorization: Token <hex session token>. The token is a logged-in
// session credential — it EXPIRES and must be refreshed. It lives ONLY in a
// GitHub secret (LIVE_TOKEN), never in code or chat.
//
// ToS: this is logged-in access — more sensitive than the anonymous public API.
// Be a good citizen: low concurrency, polite delays, fan-made disclaimer on the
// site. We pull modest volumes (the post-lockdown gap + new events), not a bulk
// crawl of the whole history.

const HOST = process.env.HYDRA_BASE || "https://api.cloudflare.riftbound.uvsgames.com/hydraproxy/api/v2";
const PAGE = Number(process.env.HYDRA_PAGE_SIZE || 200);
const DELAY_MS = Number(process.env.HYDRA_DELAY_MS || 350); // polite pacing between requests

// Token resolution: prefer a dedicated LIVE_TOKEN, fall back to PROBE_TOKEN
// (the spike secret) so existing CI wiring keeps working. Accept "Token x",
// "Bearer x", or a bare token; normalize to the DRF "Token " scheme.
function authHeader() {
  let t = (process.env.LIVE_TOKEN || process.env.HYDRA_TOKEN || process.env.PROBE_TOKEN || "").trim();
  if (!t) throw new Error("Missing LIVE_TOKEN (logged-in session token). Set it as a GitHub secret — never in chat.");
  if (/^token\s+/i.test(t)) return t.replace(/^token\s+/i, "Token ");
  if (/^bearer\s+/i.test(t)) return "Token " + t.replace(/^bearer\s+/i, "");
  return "Token " + t;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET with backoff. 401/403 fail fast (token expired/insufficient → human must
// refresh the secret); 5xx/429/network retried; 404 → null (lets callers probe
// candidate paths without throwing).
async function get(path, { tries = 4 } = {}) {
  const headers = {
    Authorization: authHeader(),
    Accept: "application/json",
    Origin: "https://locator.riftbound.uvsgames.com",
    Referer: "https://locator.riftbound.uvsgames.com/",
  };
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    let res;
    try {
      res = await fetch(`${HOST}/${path}`, { headers });
    } catch (e) {
      lastErr = e;
      await sleep(1200 * attempt);
      continue;
    }
    if (res.status === 404) return null;
    if (res.ok) return res.json();
    const body = await res.text().catch(() => "");
    if (res.status === 401) throw new Error(`401 on ${path} — LIVE_TOKEN missing/expired. Re-login and refresh the secret.`);
    if (res.status === 403) throw new Error(`403 on ${path} — token lacks permission for this resource.`);
    if (res.status >= 500 || res.status === 429) {
      lastErr = new Error(`GET ${path} -> ${res.status}`);
      await sleep(1500 * attempt);
      continue;
    }
    throw new Error(`GET ${path} -> ${res.status} ${body.slice(0, 160)}`);
  }
  throw new Error(`${lastErr?.message || "request failed"} (after ${tries} attempts)`);
}

/** Full event detail (metadata + tournament_phases). */
export const getEventDetail = (eventId) => get(`events/${eventId}/`);

/** Phase detail — fallback source for a phase's round list. */
export const getPhaseDetail = (phaseId) => get(`tournament-phases/${phaseId}/`);

/**
 * Discover the ordered round ids for an event WITHOUT a dedicated round-list
 * endpoint (none found yet). Strategy, in order:
 *   1. rounds nested under tournament_phases[] in the event detail;
 *   2. rounds from each phase's own detail (tournament-phases/<id>/).
 * Returns [{ roundId, roundNumber, phaseId }] in play order. Empty array means
 * neither shape carried rounds — run INSPECT mode to see the real JSON.
 */
export async function discoverRoundIds(eventId, { log = () => {} } = {}) {
  const ev = await getEventDetail(eventId);
  if (!ev) throw new Error(`event ${eventId} not found`);
  const phases = ev.tournament_phases || ev.phases || [];
  log(`  event ${eventId}: ${phases.length} phase(s)`);
  const out = [];
  for (const ph of phases) {
    let rounds = ph.tournament_rounds || ph.rounds || null;
    if (!rounds || !rounds.length) {
      await sleep(DELAY_MS);
      const pd = await getPhaseDetail(ph.id).catch(() => null);
      rounds = pd?.tournament_rounds || pd?.rounds || null;
    }
    for (const r of rounds || []) {
      if (r?.id != null) out.push({ roundId: r.id, roundNumber: r.round_number ?? r.number ?? null, phaseId: ph.id });
    }
  }
  // Stable order: by round_number when present, else by id (ids are sequential).
  out.sort((a, b) => (a.roundNumber ?? a.roundId) - (b.roundNumber ?? b.roundId));
  return out;
}

/** All raw match objects for one round (paginated). */
export async function getRoundMatches(roundId) {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const j = await get(`tournament-rounds/${roundId}/matches/paginated/?page=${page}&page_size=${PAGE}`);
    if (!j) break;
    const batch = j.results || j.matches || (Array.isArray(j) ? j : []);
    out.push(...batch);
    if (!j.next || batch.length < PAGE) break;
    await sleep(DELAY_MS);
  }
  return out;
}

/**
 * Map a hydraproxy match into the raw shape normalize.matchToCanonical expects
 * (a `players[]` array with player_order / games_won / player{id,best_identifier}).
 * Keeping ONE canonicalizer means the privacy + winner rules live in one place.
 *
 * Field names handled defensively because this backend's exact shape is locked
 * by the first INSPECT run; adjust here if a name differs. The hydra match uses
 * `player_match_relationships` instead of the old `players`.
 */
export function hydraToRaw(m) {
  const rels = m.player_match_relationships || m.players || m.player_relationships || [];
  const players = rels.map((r, i) => {
    const p = r.player || r.user || r.player_event_status?.player || {};
    // Prefer the per-event NICKNAME (user_event_status.best_identifier, e.g.
    // "Feldherr9999") over the player-level identifier (an initial-form real
    // name like "Andreas K"): better for display AND for GDPR. Falls back to the
    // player identifier, then resolve-nicknames fills any gaps later.
    const ues = r.user_event_status || {};
    const handle = ues.best_identifier || ues.display_name || p.best_identifier || p.user_identifier || p.display_name;
    return {
      player_order: r.player_order ?? r.order ?? r.seat ?? i,
      games_won: r.games_won ?? r.games_won_count ?? r.wins ?? 0,
      player: { id: p.id, best_identifier: handle },
    };
  });
  return {
    id: m.id,
    table_number: m.table_number ?? m.table ?? null,
    // Omit status unless explicitly COMPLETE-meaning: matchToCanonical's winner
    // logic already skips unfinished matches (no winner, 0-0). Passing a foreign
    // status string would wrongly reject finished matches.
    status: undefined,
    match_is_bye: m.match_is_bye ?? m.is_bye ?? false,
    match_is_intentional_draw: m.match_is_intentional_draw ?? false,
    match_is_unintentional_draw: m.match_is_unintentional_draw ?? false,
    games_drawn: m.games_drawn ?? 0,
    winning_player: m.winning_player ?? null,
    players,
  };
}

export const config = { HOST, PAGE, DELAY_MS };
