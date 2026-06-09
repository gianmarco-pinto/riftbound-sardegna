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

/** Rounds/phases for an event (TOKEN). */
export async function getEventRounds(eventId) {
  return get(`/api/magic-events/${eventId}/get_all_rounds/`, { auth: true });
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

export function isSardinian(event) {
  const s = event.store || {};
  if (s.country && s.country !== "IT") return false;
  if (SARD_REGION.test(s.administrative_area_level_1_short || "")) return true;
  if (SARD_PROVINCES.test(s.administrative_area_level_1_short || "")) return true;
  if (typeof s.latitude === "number" && typeof s.longitude === "number") {
    return inSardiniaBBox(s.latitude, s.longitude);
  }
  return false;
}

export const config = { BASE, GAME_SLUG };
