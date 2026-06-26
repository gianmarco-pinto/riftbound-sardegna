# Riftladder pipeline — runbook

Operational guide for the data pipeline (this repo) that powers the Riftladder
site. Read this before touching the pipeline or recovering from an incident.

## Architecture (CQRS, build-time)

- **Write model** — a SQLite DB (`data/riftbound.db`): `players`, `events`,
  `placements`, `matches`, `ratings`, `rating_snapshots`, `stores`.
- **Projection** — `build-site.mjs` reads the DB and writes denormalized JSON
  shards under `site/` (per-scope leaderboards, per-player profiles, per-event
  standings, circuit, search index).
- **Read model** — those shards, published to **Supabase Storage** (public bucket
  `rankings`). The website reads the shards directly; data updates need **no
  redeploy/Publish**. (Auth/DB for the site live in its own Supabase project.)

The site repo is `riftbound-card-keeper` (Lovable). It reads
`https://bklmwueojaftiedhwazp.supabase.co/storage/v1/object/public/rankings/...`.

## Pipeline (CI: `.github/workflows/refresh.yml`, every 2h)

1. **Download state** from the GitHub Release `state` (see below). Fail-loud: if
   the release exists but `riftbound.db` doesn't download, the run ABORTS (never
   silently bootstraps a stale copy).
2. **state-guard check** — aborts if the loaded DB or nickname map shrank >20% vs
   the last known-good baseline. Writes a `data/.state-ok` marker on pass.
3. `discover.mjs` → new events. `ingest-registrations.mjs` → placements + players
   (public UVS registrations endpoint; W/L/D, final standings). `rate.mjs` →
   Glicko from `matches`. `build-site.mjs` → shards. `publish-supabase.mjs` →
   upload changed shards.
4. **Upload state** — only if `.state-ok` exists (so bad state is never
   persisted). Refreshes the guard baseline + a daily DB snapshot.

`workflow_dispatch` input `full_profiles=true` forces a full profile sweep (all
players), needed when every profile shard must be regenerated.

## State lives in the GitHub Release `state` (NOT Supabase)

Assets, downloaded at the start of each run and re-uploaded at the end:
- `riftbound.db` — the source-of-truth SQLite DB.
- `riftbound-YYYYMMDD.db` — daily snapshots, last 7 kept (recovery).
- `nicknames-resolved.json` — **the resolved IGN map**. Display name =
  `MANUAL[id] || RESOLVED[id] || initials(rawName)`. The DB's `players.handle`
  holds the RAW UVS name (often a real name); good display nicknames come from
  THIS map. It is a frozen passthrough asset (`resolve-nicknames.mjs` is not run
  in CI). If it shrinks, most players show real-name initials.
- `state-stats.json` / `publish-stats.json` — guard baselines (row counts /
  published player count).
- `publish-manifest.json` — content-hash manifest so publish only re-uploads
  changed shards.

## Resilience guards (added after the 2026-06 incident)

- `state-guard.mjs check|update` — shrink guard on DB row counts + resolved-map
  size. `STATE_SHRINK_THRESH` (default 0.8) overrides the 20% threshold for a
  legitimate large drop.
- `.state-ok` marker gates the upload step.
- Fail-loud download; daily DB snapshots.

## Recovery procedures

**A) DB regressed / corrupted (players/matches/placements dropped).**
The published Supabase shards are a complete copy. Rebuild the DB from them:
```
node src/reconstruct-from-shards.mjs /tmp/rebuilt.db        # full
node src/reconstruct-from-shards.mjs /tmp/rebuilt.db 800    # quick sample to test
```
Verify counts, then `cp /tmp/rebuilt.db data/riftbound.db` and
`gh release upload state data/riftbound.db --clobber`. NOTE: shards lack
`store_id`; merge it from the previous DB (`ATTACH` + UPDATE) so RQ/Regional tiers
stay correct (only ~8 genuine RQs need it; "RQ Celebration" look-alikes should
stay untiered).

**B) Names show as initials (resolved-map shrank).**
The good map is a passthrough; restore the largest known-good copy:
```
gh release upload state path/to/good/nicknames-resolved.json --clobber
```
Then run `full_profiles=true` to rebuild every shard. ⚠️ First cancel/await any
in-flight run — a run that downloaded the small map re-uploads it on finish and
clobbers your restore. The guard now aborts such runs once the baseline is good.

## Hard-won lessons (do not repeat)

- **Verify migrations IN A BROWSER, not just curl** — the R2 attempt failed
  because the r2.dev public URL sends no CORS headers (curl ignores CORS).
- **Never churn the `state` release while runs are active** — concurrent uploads
  + a failed download made a run fall back to a stale DB and overwrite good state.
- **The resolved-map and the DB are both critical state** — both are guarded now.

## Backlog (not yet done)

- Append-only archive of raw UVS responses → the DB becomes fully replayable
  (real event-sourcing safety net), instead of relying on the published shards.
