// Thin client for the UVS / Spicerack "play" API — the backend behind the
// official Riftbound locator (locator.riftbound.uvsgames.com).
//
// IMPORTANT BACKGROUND: Riftbound organized play MIGRATED off carde.io onto
// this platform. Store records here still carry `legacy_carde_id` /
// `legacy_carde_migrated_at` as proof. carde.io is the dead/old backend; this
// is the live one. (All endpoints below verified live against real Sardinian
// events in June 2026.)
//
// Auth model (verified):
//   - Header:  Authorization: Token <token>     (DRF TokenAuth — scheme is
//              "Token", NOT "Bearer".)
//   - Event DISCOVERY is PUBLIC (no token).
//   - Match RESULTS (rounds + pairings) require the token.
//   - Sending Origin/Referer of the locator avoids occasional CORS/edge blocks.

const BASE = process.env.UVS_BASE || "https://api.riftbound.uvsgames.com";
const GAME_SLUG = process.env.RIFTBOUND_GAME_SLUG || "riftbound";

function authHeader() {
  let t = (process.env.UVS_TOKEN || "").trim();
  if (!t) return null;
  // Accept "Token xxx", "Bearer xxx" (we normalize), or a bare token.
  if (/^token\s+/i.test(t)) return t.replace(/^token\s+/i, "Token ");
  if (/^bearer\s+/i.test(t)) return "Token " + t.replace(/^bearer\s+/i, "");
  return "Token " + t;
}

function headers({ auth = false } = {}) {
  const h = {
    Accept: "application/json",
    Origin: "https://locator.riftbound.uvsgames.com",
    Referer: "https://locator.riftbound.uvsgames.com/",
  };
  if (auth) {
    const a = authHeader();
    if (!a) {
      throw new Error(
        "Missing UVS_TOKEN. Put it in .env (see .env.example). " +
          "Get it from a logged-in locator session: DevTools > Network > " +
          "api.riftbound.uvsgames.com request > Request Headers > authorization."
      );
    }
    h.Authorization = a;
  }
  return h;
}

async function get(path, { auth = false } = {}) {
  const res = await fetch(BASE + path, { headers: headers({ auth }) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401) {
      throw new Error(`401 on ${path} — token missing/expired. Refresh UVS_TOKEN.`);
    }
    if (res.status === 403) {
      throw new Error(`403 on ${path} — token lacks permission for this resource.`);
    }
    throw new Error(`GET ${path} -> ${res.status} ${body.slice(0, 160)}`);
  }
  return res.json();
}

/**
 * One page of the global events feed (ALL games, ALL regions).
 * PUBLIC. The backend ignores most query filters (game/country/geo), so callers
 * must filter client-side — see isRiftbound() / isSardinian() below.
 * Returns { results, next, total }.
 */
export async function listEventsPage(page = 1, pageSize = 100) {
  const j = await get(`/api/magic-events/?page_size=${pageSize}&page=${page}`);
  return { results: j.results || [], next: j.next || null, total: j.total ?? j.count ?? null };
}

/** Full event detail (PUBLIC). Includes store address + coordinates. */
export async function getEvent(eventId) {
  return get(`/api/magic-events/${eventId}/`);
}

/**
 * Geographic event search (TOKEN) — the ONE endpoint that honours filters.
 * Unlike /api/magic-events/ (a fixed unfilterable feed), /api/v2/events/
 * respects latitude/longitude/num_miles + game_slug + start_date_after/before
 * and returns distance_in_miles. This is the primitive that scales worldwide:
 * point it anywhere with any radius.
 * Returns the full list of raw v2 events (paginated internally).
 */
export async function searchEventsGeo({
  lat, lng, miles = 200, gameSlug = GAME_SLUG,
  after = "2024-01-01T00:00:00Z", before = "2027-12-31T00:00:00Z",
  pageSize = 50, maxPages = 80,
} = {}) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const qs = new URLSearchParams({
      latitude: lat, longitude: lng, num_miles: miles, game_slug: gameSlug,
      start_date_after: after, start_date_before: before, page_size: pageSize, page,
    });
    const j = await get(`/api/v2/events/?${qs}`, { auth: true });
    all.push(...(j.results || []));
    if (!j.next) break;
  }
  return all;
}

/** Rounds/phases for an event (TOKEN). Returns the raw phase list. */
export async function getEventRounds(eventId) {
  return get(`/api/magic-events/${eventId}/get_all_rounds/`, { auth: true });
}

/**
 * Flattened list of round ids for an event (TOKEN). The endpoint returns
 * "phases", each containing a `rounds[]` array; we flatten to ids in order.
 * (Some shapes return rounds directly — handled defensively.)
 */
export async function getEventRoundIds(eventId) {
  const phases = await getEventRounds(eventId);
  const ids = [];
  for (const ph of Array.isArray(phases) ? phases : []) {
    if (Array.isArray(ph.rounds)) for (const r of ph.rounds) ids.push(r.id);
    else if (ph.id != null && ph.round_number != null) ids.push(ph.id); // round-shaped
  }
  return ids;
}

/** All matches (pairings + results) for one round (TOKEN). */
export async function getRoundMatches(roundId) {
  return get(`/api/tournament-rounds/${roundId}/include_all_matches/`, { auth: true });
}

/** The logged-in user's own past event registrations (TOKEN). Handy seed for
 *  discovering Sardinian events you personally attended. */
export async function getMyPastRegistrations() {
  return get(`/api/event-statuses/list_past_registrations/`, { auth: true });
}

/** The token owner's own game profile (TOKEN): { user, display_name, ... }.
 *  `display_name` is the player's NICKNAME (e.g. "Sciupy"); `user` is the stable
 *  player id used throughout the match data. */
export async function getSelfProfile() {
  return get(`/api/v2/game-user/self?game_slug=${GAME_SLUG}`, { auth: true });
}

/**
 * The token owner's full tournament history (TOKEN). Each match exposes
 * `opponent_id` + `opponent_display_name` — i.e. clean (stable id -> nickname)
 * pairs for every opponent this account has faced. This is the only public way
 * to bind a nickname to a stable id in bulk; aggregating several accounts'
 * histories converges to full nickname coverage (the worldwide strategy).
 */
export async function getMyTournamentHistory() {
  const out = [];
  for (let page = 1; page <= 200; page++) {
    const j = await get(
      `/api/v2/player/games/${GAME_SLUG}/tournament-history/?game_slug=${GAME_SLUG}&page_size=25&page=${page}`,
      { auth: true }
    );
    out.push(...(j.results || []));
    if (!j.next) break;
  }
  return out;
}

// --- Classification helpers (client-side, since server filters are ignored) ---

export function isRiftbound(event) {
  const g = (event.game_type_pretty || event.game_type || event.game || "").toString().toLowerCase();
  return g.includes("riftbound");
}

// Sardinian province codes + region spellings + bounding box (lat/lng).
const SARD_PROVINCES = /^(CA|SS|NU|OR|SU)$/i;
const SARD_REGION = /^(sardegna|sardinia)$/i;
function inSardiniaBBox(lat, lng) {
  return lat > 38.8 && lat < 41.4 && lng > 8.0 && lng < 10.0;
}

// Curated allowlist for store objects that come back WITHOUT an address (e.g.
// the `store` nested in past-registrations is stripped to id+name). Grows as we
// confirm stores. Matching is by id (preferred) or name substring.
export const KNOWN_SARDINIAN_STORE_IDS = new Set([1884 /* GamePeople Quartu */]);
const KNOWN_SARDINIAN_STORE_NAME =
  /(dual dimension|nekopon|gamepeople|game people|red forge|ongame)/i;

/** Is this STORE in Sardinia? Works on full (address) and stripped shapes.
 *  Country exclusion comes FIRST: an explicitly-foreign store (e.g. a Corsica/FR
 *  shop within radius) is never Sardinian, whatever its name. The name allowlist
 *  only helps stripped shapes where country/region are absent. */
export function isSardinianStore(store) {
  const s = store || {};
  if (s.country && s.country !== "IT") return false;
  if (KNOWN_SARDINIAN_STORE_IDS.has(s.id)) return true;
  if (KNOWN_SARDINIAN_STORE_NAME.test(s.name || "")) return true;
  // region lives in `state` (v2 events) or `administrative_area_level_1_short` (feed)
  const region = s.state || s.administrative_area_level_1_short || "";
  if (SARD_REGION.test(region)) return true;
  if (SARD_PROVINCES.test(region)) return true;
  if (typeof s.latitude === "number" && typeof s.longitude === "number") {
    return inSardiniaBBox(s.latitude, s.longitude);
  }
  return false;
}

export function isSardinian(event) {
  return isSardinianStore(event.store);
}

// Canonicalize region spelling. The source uses "Sardegna", "Sardinia", or a
// province code (SS/CA/NU/OR/SU) interchangeably; collapse them so regional
// leaderboards group correctly. (Worldwide: extend this map per country.)
const IT_REGION_ALIASES = {
  sardinia: "Sardegna", sardegna: "Sardegna",
  ss: "Sardegna", ca: "Sardegna", nu: "Sardegna", or: "Sardegna", su: "Sardegna",
};
export function normalizeRegion(country, region) {
  if (!region) return region ?? null;
  if (country === "IT") {
    const c = IT_REGION_ALIASES[region.trim().toLowerCase()];
    if (c) return c;
  }
  return region;
}

export const config = { BASE, GAME_SLUG };
