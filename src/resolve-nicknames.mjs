// Resolve player nicknames (stable id -> nickname) AND final placements for
// every event in the catalog, from the same v2 standings call.
//
// Outputs:
//   data/nicknames-resolved.json  { playerId: nickname }
//   data/placements.json          { eventId: { participants, places: { playerId: rank } } }
//
// SOURCE: v2 round standings expose, for ALL participants of an event:
//   - user_event_status.best_identifier -> the player's NICKNAME (display_name)
//   - player.id + rank                  -> final placement (we read the LAST
//     round's standings, which are cumulative/final)
// Readable for any event with our own token. Real names are never stored.
//
// Usage:  node --env-file=.env src/resolve-nicknames.mjs

import { getEventRoundIds, getRoundStandingsV2 } from "./uvsgames.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const NICK_FILE = "data/nicknames-resolved.json";
const PLACE_FILE = "data/placements.json";

let nicks = {};
try { nicks = JSON.parse(readFileSync(NICK_FILE, "utf8")); } catch {}
let placements = {};
try { placements = JSON.parse(readFileSync(PLACE_FILE, "utf8")); } catch {}
const nicksBefore = Object.keys(nicks).length;

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

let nickAdded = 0, placedEvents = 0;
console.log(`Resolving nicknames + placements across ${events.length} events...`);
for (const eventId of events) {
  let roundIds;
  try { roundIds = await getEventRoundIds(eventId); } catch { continue; }
  // Last round's standings are final (cover all players, including drops).
  for (const rid of roundIds.slice().reverse()) {
    let standings;
    try { standings = await getRoundStandingsV2(rid); } catch { continue; }
    if (!standings.length) continue;
    const places = {};
    for (const s of standings) {
      const id = s.player?.id;
      if (id == null) continue;
      const real = s.player?.best_identifier;
      const nick = s.user_event_status?.best_identifier;
      if (isRealNickname(nick, real)) {
        const k = String(id);
        if (!nicks[k]) nickAdded++;
        nicks[k] = nick;
      }
      if (s.rank != null) places[String(id)] = s.rank;
    }
    if (Object.keys(places).length) {
      placements[String(eventId)] = { participants: standings.length, places };
      placedEvents++;
    }
    break; // last completed round is enough
  }
}

mkdirSync("data", { recursive: true });
writeFileSync(NICK_FILE, JSON.stringify(nicks, null, 2));
writeFileSync(PLACE_FILE, JSON.stringify(placements, null, 2));
console.log(`Nicknames: ${nicksBefore} -> ${Object.keys(nicks).length} (+${nickAdded} new).`);
console.log(`Placements: ${placedEvents} events this run, ${Object.keys(placements).length} total. Saved ${NICK_FILE} + ${PLACE_FILE}.`);
