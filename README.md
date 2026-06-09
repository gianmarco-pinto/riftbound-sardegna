# Riftbound Sardegna — Player Ratings

A chess/tennis-style player rating (Glicko-2) and public leaderboard for
**Riftbound 1v1 events in Sardinia**. Players can look up their rating, stats,
best wins / worst losses, and head-to-head records.

## Data source

Data comes from the **UVS / Spicerack play API** (`api.riftbound.uvsgames.com`),
the backend behind the official Riftbound locator
(`locator.riftbound.uvsgames.com`).

> **Note on platform.** Riftbound organized play *migrated off carde.io* onto
> this UVS/Spicerack backend. Store records here still carry `legacy_carde_id` /
> `legacy_carde_migrated_at` from that migration. An earlier prototype targeted
> carde.io — that platform is effectively empty of recent Italian/Sardinian
> events and is **not** used here.

### What we verified (live, June 2026)

- **Event discovery is public** (no token): `GET /api/magic-events/`. The server
  ignores game/region/geo query params, so we sweep the feed and filter
  client-side. Each event carries its store's `country`,
  `administrative_area_level_1_short` (region/province), and `latitude/longitude`.
- **Match results require a token** (`Authorization: Token <t>` — DRF TokenAuth,
  scheme is `Token`, not `Bearer`):
  - `GET /api/magic-events/{id}/get_all_rounds/`
  - `GET /api/tournament-rounds/{roundId}/include_all_matches/` → full pairings:
    both players, `winning_player`, games won, draws, byes.
- **Confirmed Sardinian Riftbound stores:** Dual Dimension (Cagliari),
  Nekopon Store (Cagliari), GamePeople Quartu (Quartu S.E.), Red Forge.

## Privacy / GDPR (by design)

The raw results API exposes players' **email and full name**. This project
**discards** that at ingestion and keeps only:

- the stable internal `player.id`
- the public handle (`best_identifier`, e.g. "Dave M")

Email, first name, and last name never leave `src/normalize.mjs`. The public
site shows handles only. (Data minimization → fewer GDPR obligations.) An
opt-out path for the public board is planned.

## Architecture

```
src/uvsgames.mjs   API client (discovery = public; results = token)
src/normalize.mjs  raw match -> CanonicalMatch (the swappable adapter; PII dropped here)
src/discover.mjs   find Sardinian Riftbound events (public sweep)
src/ingest.mjs     [todo] pull rounds+matches for events, accumulate into the DB
src/rate.mjs       [todo] Glicko-2 engine + per-tournament rating snapshots
```

The rating engine consumes a source-agnostic `CanonicalMatch`, so the data
source is isolated behind `uvsgames.mjs` + `normalize.mjs`.

## Setup

```bash
npm install
cp .env.example .env   # paste your UVS token (see that file for how)
```

Requires Node 18+ (built-in `fetch`). `.env` is git-ignored — never commit a token.

## Usage

```bash
# Find Sardinian Riftbound events (public, no token). Arg = max pages to sweep.
node src/discover.mjs 80
```

## Status

Working: project scaffold, verified API client, PII-safe normalizer, live event
discovery. Next: results ingestion → SQLite → Glicko-2 with inactivity decay +
rating snapshots → web leaderboard & player profiles.
