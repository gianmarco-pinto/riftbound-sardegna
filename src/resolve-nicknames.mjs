// Resolve player nicknames (stable id -> display_name) and accumulate them in
// data/nicknames-resolved.json.
//
// WHY THIS IS THE GLOBAL SOLUTION: the platform exposes nicknames bound to a
// stable id only through an account's own data — your profile (game-user/self)
// and your opponents (tournament-history: opponent_id + opponent_display_name).
// There is no public bulk "all players -> nickname" endpoint. So each account
// contributes the nicknames of itself + everyone it has played. Run this for one
// account to seed; run it for more accounts (any region) and the map converges
// to full coverage — same mechanism worldwide, no manual mapping, no real names.
//
// Usage:  node --env-file=.env src/resolve-nicknames.mjs
//   (TOKEN of the account whose history you want to contribute)

import { getSelfProfile, getMyTournamentHistory } from "./uvsgames.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const FILE = "data/nicknames-resolved.json";

// load + accumulate (so multiple accounts/runs union together)
let map = {};
try { map = JSON.parse(readFileSync(FILE, "utf8")); } catch {}
const before = Object.keys(map).length;
let added = 0;
const put = (id, nick) => {
  if (id == null || !nick) return;
  const k = String(id);
  if (!map[k]) added++;
  map[k] = nick; // latest wins (nicknames can change)
};

// 1) the token owner
try {
  const me = await getSelfProfile();
  put(me.user, me.display_name);
  console.log(`Self: ${me.display_name} (id ${me.user})`);
} catch (e) { console.error(`self profile failed: ${e.message}`); }

// 2) all opponents from this account's history
const history = await getMyTournamentHistory();
let matchCount = 0;
for (const ev of history) {
  for (const m of ev.matches || []) {
    matchCount++;
    put(m.opponent_id, m.opponent_display_name);
  }
}

mkdirSync("data", { recursive: true });
writeFileSync(FILE, JSON.stringify(map, null, 2));
console.log(`History: ${history.length} events, ${matchCount} matches scanned.`);
console.log(`Nicknames: ${before} known -> ${Object.keys(map).length} (+${added} new). Saved ${FILE}.`);
