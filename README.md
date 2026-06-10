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

The raw results API exposes players' **email and full name**. There is **no
nickname field** on the platform — every identifier (`best_identifier`,
`user_identifier`) is the real name as "First L." At ingestion we discard email,
first name and last name, keeping only the stable `player.id` and that
name-derived label (used internally, never published as-is).

**The public site never shows real names.** Players have a real **nickname**
(`display_name`, e.g. "Sciupy") in their game profile, but the platform only
binds a nickname to a stable id through an account's own data. Display identity
is resolved in `src/build-site.mjs` from three sources, in order:

1. **`nicknames.json`** — manual / opt-in overrides (committed).
2. **`data/nicknames-resolved.json`** — auto-resolved by `resolve-nicknames.mjs`
   from **v2 round standings**, where `user_event_status.best_identifier` is the
   player's nickname (next to the stable `player.id`), in bulk for every
   participant. Readable for ANY event with a single token — no other accounts,
   no real names. ≈ 95% of players (those who set a nickname); same call works
   worldwide.
3. **Initials** of the real name (e.g. "L. P.") — for the few who never set a
   nickname. Never the full name.

So `site/data.json` contains only nicknames or initials — no real names, no
emails. (Data minimization → fewer GDPR obligations.)

**Opt-out (GDPR):** to remove a player from the public site on request, add
their stable id to `excluded.json` and let the nightly run republish (or run
`build:site` + `publish:supabase` manually). They become "Anonimo" everywhere:
no leaderboard rows, no profile page, anonymized in opponents' histories.
Their matches stay in the rating math — removing them would corrupt other
players' ratings.

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
