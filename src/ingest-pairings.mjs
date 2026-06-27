// Ingest EXACT pairings for concluded events from the authenticated hydraproxy
// backend (the live website's own API). This recovers the post-lockdown GAP:
// events for which the dead anonymous endpoint left us with standings only.
// Once an event's real matches land, rate.mjs computes its exact Glicko and the
// Phase-B estimate is no longer used for it.
//
// MODES:
//   INSPECT=1 EVENT_IDS=545120   -> dump the real JSON shapes (event detail,
//       discovered rounds, first raw match) and a dry-run canonical map. Run
//       this FIRST on a known event to lock field names before bulk ingest.
//   (default) EVENT_IDS=545120,... -> ingest those events.
//   (default, no EVENT_IDS)      -> auto-pick the post-lockdown gap
//       (eventsNeedingPairings), capped by MAX_EVENTS.
//
// AUTH: needs LIVE_TOKEN (a logged-in session token) — GitHub secret only.
//
// Usage:
//   INSPECT=1 EVENT_IDS=545120 node src/ingest-pairings.mjs
//   EVENT_IDS=545120 node src/ingest-pairings.mjs
//   MAX_EVENTS=200 node src/ingest-pairings.mjs

import { discoverRoundIds, getRoundMatches, getEventDetail, hydraToRaw, config } from "./hydra.mjs";
import { matchToCanonical } from "./normalize.mjs";
import {
  upsertPlayer, upsertMatch, markPairings, eventsNeedingPairings, transaction, db,
} from "./db.mjs";

const INSPECT = process.env.INSPECT === "1";
const MAX_EVENTS = Number(process.env.MAX_EVENTS || 100);
// Lockdown floor: events on/after this date are the gap worth backfilling
// (pre-lockdown events already carry real matches). Override with SINCE_DATE.
const SINCE = process.env.SINCE_DATE || "2026-06-15";
const log = (m) => console.log(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function targets() {
  const ids = (process.env.EVENT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length) return ids.map((id) => ({ id: Number(id), date: null, name: null }));
  return eventsNeedingPairings(MAX_EVENTS, SINCE);
}

// ---- INSPECT: lock the real JSON shapes, change nothing ----
async function inspect(eventId) {
  log(`\n=== INSPECT event ${eventId} ===`);
  const ev = await getEventDetail(eventId);
  if (!ev) { log("event not found"); return; }
  log(`event top-level keys: ${Object.keys(ev).join(", ")}`);
  const phases = ev.tournament_phases || ev.phases || [];
  log(`phases: ${phases.length}`);
  if (phases[0]) log(`phase[0] keys: ${Object.keys(phases[0]).join(", ")}`);

  const rounds = await discoverRoundIds(eventId, { log });
  log(`discovered ${rounds.length} round(s): ${rounds.map((r) => `${r.roundNumber ?? "?"}#${r.roundId}`).join(", ") || "(none — round shape not in event/phase detail)"}`);
  if (!rounds.length) { log("→ no rounds found: dump phase[0] detail to find the round list"); return; }

  const ms = await getRoundMatches(rounds[0].roundId);
  log(`round ${rounds[0].roundId}: ${ms.length} match(es)`);
  if (ms[0]) {
    log(`raw match[0]:\n${JSON.stringify(ms[0], null, 1).slice(0, 1800)}`);
    const canon = matchToCanonical(hydraToRaw(ms[0]), { eventId, roundId: rounds[0].roundId, roundNumber: rounds[0].roundNumber, date: ev.start_datetime || ev.date || null });
    log(`canonical[0]: ${JSON.stringify(canon)}`);
  }
}

// ---- INGEST: pull rounds → matches → upsert players+matches → mark ----
async function ingest(ev) {
  let canon = [];
  const rounds = await discoverRoundIds(ev.id, { log: () => {} });
  if (!rounds.length) throw new Error("no rounds discovered (run INSPECT to find the round shape)");
  for (const r of rounds) {
    const ms = await getRoundMatches(r.roundId);
    for (const m of ms) {
      const c = matchToCanonical(hydraToRaw(m), { eventId: ev.id, roundId: r.roundId, roundNumber: r.roundNumber, date: ev.date });
      if (c) canon.push(c);
    }
    await sleep(config.DELAY_MS);
  }
  const real = canon.filter((c) => !c.isBye && c.winner);
  transaction(() => {
    for (const c of canon) {
      if (c.playerA?.id) upsertPlayer(c.playerA.id, c.playerA.name, ev.date);
      if (c.playerB?.id) upsertPlayer(c.playerB.id, c.playerB.name, ev.date);
      upsertMatch(c);
    }
    markPairings(ev.id);
  });
  return { rounds: rounds.length, matches: canon.length, rated: real.length };
}

// ---- main ----
const todo = targets();
log(`ingest-pairings: ${INSPECT ? "INSPECT" : "INGEST"} | ${todo.length} event(s) | host ${config.HOST} | delay ${config.DELAY_MS}ms`);

if (INSPECT) {
  for (const ev of todo) await inspect(ev.id);
} else {
  let ok = 0, totalMatches = 0, totalRated = 0, failed = 0;
  for (const ev of todo) {
    try {
      const r = await ingest(ev);
      ok++; totalMatches += r.matches; totalRated += r.rated;
      log(`  ✓ ${ev.id} ${(ev.date || "").slice(0, 10)} — ${r.rounds} rounds, ${r.matches} matches (${r.rated} rated)`);
    } catch (e) {
      failed++;
      log(`  ✗ ${ev.id}: ${e.message}`);
    }
    await sleep(config.DELAY_MS);
  }
  log(`\nDone: ${ok} events ingested (${totalMatches} matches, ${totalRated} rated), ${failed} failed.`);
  log(`DB total matches: ${db.prepare("SELECT COUNT(*) c FROM matches").get().c}.`);
}
