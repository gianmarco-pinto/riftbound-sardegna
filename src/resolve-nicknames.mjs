// Resolve player nicknames (id -> nickname) and final placements from v2 round
// standings — INCREMENTAL: only events that have matches but no placements yet.
// Capped per run (MAX_STANDINGS) for CI time limits.
//
// Outputs: data/nicknames-resolved.json (accumulating map) + `placements` table.
// user_event_status.best_identifier is the NICKNAME; real names never stored.
//
// Usage:  node --env-file=.env src/resolve-nicknames.mjs
//   env: MAX_STANDINGS=800

import { getEventRoundIds, getRoundStandingsV2 } from "./uvsgames.mjs";
import { eventsNeedingPlacements, upsertPlacement, transaction } from "./db.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const NICK_FILE = "data/nicknames-resolved.json";
const MAX = Number(process.env.MAX_STANDINGS || 800);

let nicks = {};
try { nicks = JSON.parse(readFileSync(NICK_FILE, "utf8")); } catch {}
const before = Object.keys(nicks).length;

function isRealNickname(nick, realName) {
  if (!nick) return false;
  if (/^User\d+$/i.test(nick)) return false;
  if (nick === realName) return false;
  return true;
}

const todo = eventsNeedingPlacements(MAX);
console.log(`Standings to fetch: ${todo.length} event(s) (cap ${MAX})...`);

let placed = 0, nickAdded = 0, failed = 0;
for (const { id: eventId } of todo) {
  try {
    const roundIds = await getEventRoundIds(eventId);
    for (const rid of roundIds.slice().reverse()) {
      let standings;
      try { standings = await getRoundStandingsV2(rid); } catch { continue; }
      if (!standings.length) continue;
      transaction(() => {
        for (const s of standings) {
          const id = s.player?.id;
          if (id == null) continue;
          const nick = s.user_event_status?.best_identifier;
          if (isRealNickname(nick, s.player?.best_identifier)) {
            const k = String(id);
            if (!nicks[k]) nickAdded++;
            nicks[k] = nick;
          }
          if (s.rank != null) upsertPlacement(eventId, String(id), s.rank, new Set(standings.map((x) => x.player?.id)).size);
        }
      });
      placed++;
      break; // last completed round is final
    }
  } catch (e) { failed++; }
  if (placed % 50 === 0 && placed > 0) console.log(`  ...${placed} events`);
}

mkdirSync("data", { recursive: true });
writeFileSync(NICK_FILE, JSON.stringify(nicks, null, 2));
console.log(`Placements stored for ${placed} events (${failed} failed). Nicknames: ${before} -> ${Object.keys(nicks).length} (+${nickAdded}).`);
