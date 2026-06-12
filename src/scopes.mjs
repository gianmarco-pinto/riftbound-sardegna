// Geographic scopes for the worldwide rollout (Italy -> Europe -> World).
//
// DISCOVERY uses circles (the v2 events API honours lat/lng/num_miles); each
// circle is swept and results deduped by event id. INGESTION is gated by
// country codes (INGEST_COUNTRIES env, comma-separated) so we can discover
// broadly but pull match data only for enabled scopes.

export const CIRCLES = {
  // Italy (incl. islands). 250mi circles overlap on purpose; dedup handles it.
  it: [
    { lat: 45.46, lng: 9.19, miles: 250 },  // North (Milan)
    { lat: 41.90, lng: 12.50, miles: 250 }, // Center (Rome)
    { lat: 40.85, lng: 14.27, miles: 250 }, // South (Naples)
    { lat: 38.12, lng: 13.36, miles: 250 }, // Sicily (Palermo)
    { lat: 40.00, lng: 9.00, miles: 250 },  // Sardinia
  ],
  // Europe rough cover (phase 2) — enable by setting DISCOVER_SCOPE=eu
  eu: [
    { lat: 51.5, lng: -0.1, miles: 400 },  // UK/IE/BeNeLux
    { lat: 48.8, lng: 2.3, miles: 400 },   // FR
    { lat: 40.4, lng: -3.7, miles: 400 },  // ES/PT
    { lat: 50.1, lng: 8.7, miles: 400 },   // DE/CH/AT
    { lat: 52.2, lng: 21.0, miles: 400 },  // PL/CZ/SK/HU
    { lat: 41.9, lng: 12.5, miles: 400 },  // IT
    { lat: 59.3, lng: 18.1, miles: 400 },  // Nordics
    { lat: 44.4, lng: 26.1, miles: 400 },  // RO/BG/GR
  ],
};

export const INGEST_COUNTRIES = (process.env.INGEST_COUNTRIES || "IT")
  .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

// Official-organizer "stores" (no geo coordinates -> invisible to the circle
// sweep). Their events (Regional Qualifiers, PAX, championships...) are swept
// separately by store id; the venue country is parsed from the event address.
export const ORGANIZER_STORE_IDS = (process.env.ORGANIZER_STORE_IDS || "19428") // UVS Games Organized Play
  .split(",").map((s) => Number(s.trim())).filter(Boolean);

// Country-name -> ISO code for venue addresses ("..., Bologna BO, Italy").
const COUNTRY_NAMES = {
  italy: "IT", italia: "IT", usa: "US", "united states": "US", france: "FR",
  spain: "ES", españa: "ES", germany: "DE", deutschland: "DE", "united kingdom": "GB",
  uk: "GB", netherlands: "NL", belgium: "BE", austria: "AT", switzerland: "CH",
  portugal: "PT", poland: "PL", canada: "CA", mexico: "MX", méxico: "MX",
  australia: "AU", japan: "JP", "south korea": "KR", brazil: "BR", brasil: "BR",
};
/** Parse the country from a venue address tail (ISO code or country name). */
export function countryFromAddress(fullAddress) {
  if (!fullAddress) return null;
  const tail = fullAddress.split(",").map((s) => s.trim()).filter(Boolean).pop() || "";
  if (/^[A-Z]{2}$/.test(tail)) return tail;
  return COUNTRY_NAMES[tail.toLowerCase()] || null;
}

// country code -> continent code (EU, AM, AS, OC, AF)
const C = {
  EU: "IT FR ES PT DE AT CH GB IE NL BE LU PL CZ SK HU SI HR RS BA RO BG GR MT CY SE NO DK FI IS EE LV LT UA MD AL MK ME TR".split(" "),
  AM: "US CA MX BR AR CL PE CO CR PA GT EC UY PY BO VE DO PR HN SV NI JM TT".split(" "),
  AS: "JP KR CN TW HK MO TH MY SG ID PH VN IN BH AE SA IL QA KW JO LB KZ".split(" "),
  OC: "AU NZ FJ".split(" "),
  AF: "ZA EG MA TN NG KE".split(" "),
};
const COUNTRY_TO_CONTINENT = {};
for (const [cont, list] of Object.entries(C)) for (const cc of list) COUNTRY_TO_CONTINENT[cc] = cont;

export const continentOf = (countryCode) =>
  COUNTRY_TO_CONTINENT[(countryCode || "").toUpperCase()] || null;

export const CONTINENT_LABELS = { EU: "Europa", AM: "Americhe", AS: "Asia", OC: "Oceania", AF: "Africa" };
