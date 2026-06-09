// Resolve player nicknames (stable id -> nickname) for every event in the
// catalog, into data/nicknames-resolved.json.
//
// SOURCE: v2 round standings expose `user_event_status.best_identifier` — the
// player's NICKNAME (display_name) — next to the stable `player.id`, in bulk,
// for ALL participants of an event. We read the standings of each event's rounds
// with our own token (no other accounts needed) and keep the nickname only when
// the player actually set one (i.e. it differs from their real name and isn't
// the "User<id>" placeholder). Real names are never stored or shown.
//
// Same mechanism works for any event worldwide.
//
// Usage:  node --env-file=.env src/resolve-nicknames.mjs

import { getEventRoundIds, getRoundStandingsV2 } from "./uvsgames.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const FILE = "data/nicknames-resolved.json";

let map = {};
try { map = JSON.parse(readFileSync(FILE, "utf8")); } catch {}
const before = Object.keys(map).length;

let events = [];
try {
  events = JSON.parse(readFileSync("data/sardinian-events.json", "utf8")).map((e) => e.eventId);
} catch {
  console.error("data/sardinian-events.json not found — run discover.mjs first.");
  process.exit(1);
}

function isRealNickname(nick, realName) {
  if (!nick) return false;
  if (/^User\d+$/i.test(nick)) return false;   // placeholder for no-nickname players
  if (nick === realName) return false;          // defaulted to the real name => not a nickname
  return true;
}

let added = 0, scanned = 0;
console.log(`Resolving nicknames across ${events.length} events...`);
for (const eventId of events) {
  let roundIds;
  try { roundIds = await getEventRoundIds(eventId); } catch { continue; }
  // last round's standings are cumulative (all players who finished); fall back
  // to earlier rounds for anyone missing.
  for (const rid of roundIds.slice().reverse()) {
    let standings;
    try { standings = await getRoundStandingsV2(rid); } catch { continue; }
    for (const s of standings) {
      const id = s.player?.id;
      const real = s.player?.best_identifier;
      const nick = s.user_event_status?.best_identifier;
      if (id == null) continue;
      scanned++;
      if (isRealNickname(nick, real)) {
        const k = String(id);
        if (!map[k]) added++;
        map[k] = nick;
      }
    }
    break; // last round is enough; remove this to union all rounds
  }
}

mkdirSync("data", { recursive: true });
writeFileSync(FILE, JSON.stringify(map, null, 2));
console.log(`Nicknames: ${before} -> ${Object.keys(map).length} (+${added} new). Saved ${FILE}.`);
