// Incremental ingestion: pull rounds + matches for events discovered in the DB
// that (a) are in an enabled country (INGEST_COUNTRIES, default IT), (b) are in
// the past, (c) haven't been ingested yet. Capped per run (MAX_EVENTS) so it is
// resumable — built for GitHub Actions time limits. Re-running continues where
// the previous run stopped. PII is dropped in normalize.mjs.
//
// Events with no results yet are retried on later runs until they are >14 days
// old, then marked ingested anyway (results are not coming).
//
// Usage:  node --env-file=.env src/ingest.mjs
//   env: INGEST_COUNTRIES=IT   MAX_EVENTS=800

import { getEventRoundIds, getRoundMatches } from "./uvsgames.mjs";
import { matchToCanonical } from "./normalize.mjs";
import { upsertPlayer, upsertMatch, markIngested, pendingEvents, transaction, db } from "./db.mjs";
import { INGEST_COUNTRIES } from "./scopes.mjs";

const MAX_EVENTS = Number(process.env.MAX_EVENTS || 800);
const GIVE_UP_DAYS = 14;

const todo = pendingEvents(INGEST_COUNTRIES, MAX_EVENTS);
console.log(`Ingesting up to ${MAX_EVENTS} of ${todo.length} pending events (countries: ${INGEST_COUNTRIES.join(",")})...`);

let done = 0, withMatches = 0, totalMatches = 0, failed = 0;
for (const ev of todo) {
  let canon = [];
  try {
    const roundIds = await getEventRoundIds(ev.id);
    for (const rid of roundIds) {
      const rd = await getRoundMatches(rid);
      for (const m of rd.matches || []) {
        const c = matchToCanonical(m, { eventId: ev.id, roundId: rid, roundNumber: rd.round_number, date: ev.date });
        if (c) canon.push(c);
      }
    }
  } catch (e) {
    failed++;
    console.error(`  ✗ ${ev.id} ${(ev.date || "").slice(0, 10)} ${ev.name?.slice(0, 30)}: ${e.message}`);
    continue; // leave pending; retried next run
  }

  const ageDays = ev.date ? (Date.now() - Date.parse(ev.date)) / 864e5 : 0;
  if (canon.length === 0 && ageDays < GIVE_UP_DAYS) continue; // results may still come

  transaction(() => {
    for (const c of canon) {
      if (c.playerA?.id) upsertPlayer(c.playerA.id, c.playerA.name, ev.date);
      if (c.playerB?.id) upsertPlayer(c.playerB.id, c.playerB.name, ev.date);
      upsertMatch(c);
    }
    markIngested(ev.id);
  });
  done++;
  if (canon.length) { withMatches++; totalMatches += canon.length; }
  if (done % 50 === 0) console.log(`  ...${done} events done (${totalMatches} matches)`);
}

const stats = db.prepare("SELECT COUNT(*) n FROM matches").get();
console.log(`\nRun: ${done} ingested (${withMatches} with results, ${totalMatches} matches), ${failed} failed/retry.`);
console.log(`DB total matches: ${stats.n}. Pending remain: ${pendingEvents(INGEST_COUNTRIES, 1e9).length}.`);
