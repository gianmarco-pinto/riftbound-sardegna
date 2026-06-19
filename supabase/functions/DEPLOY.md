# Riftladder OG share cards — Edge Functions

Two public Supabase Edge Functions (project `bklmwueojaftiedhwazp`):

- **`og/<id>.png`** — renders the shareable "rank card" PNG on-demand from
  `players/<id>.json` (resvg-wasm + Cinzel/Inter fonts from jsDelivr). CDN-cached.
- **`share/<id>`** — serves an OG-tagged HTML page (preview = the rank card) and
  redirects humans to `https://riftladder.com/giocatore/<id>`. This is what the
  site's "Share" button links to (the SPA itself can't emit per-route OG meta).

## One-time deploy (run locally)

Requires the Supabase CLI. The personal access token stays on your machine.

```bash
# 1. install the CLI (once) — pick one:
brew install supabase/tap/supabase        # macOS
# or: npm i -g supabase

# 2. log in (opens the browser, creates a local access token)
supabase login

# 3. from the repo root, deploy both functions PUBLIC (no JWT required)
supabase functions deploy og    --project-ref bklmwueojaftiedhwazp --no-verify-jwt
supabase functions deploy share --project-ref bklmwueojaftiedhwazp --no-verify-jwt
```

`--no-verify-jwt` is required: crawlers and browsers must reach these without auth.

## Verify after deploy

```bash
# image (should download a 1200x630 PNG)
curl -s -o card.png "https://bklmwueojaftiedhwazp.supabase.co/functions/v1/og/135798.png" && file card.png

# preview HTML (should show og:image / twitter:card meta)
curl -s "https://bklmwueojaftiedhwazp.supabase.co/functions/v1/share/135798" | grep og:image
```

Then paste a `…/functions/v1/share/<id>` link in Discord / X to see the unfurl.

## Notes
- No secrets needed: fonts come from jsDelivr, player data from the public bucket.
- Cold start fetches fonts (~1 MB) + inits the wasm once, then caches in memory.
- Cache-Control on the PNG: 1h browser / 1d CDN / 7d stale-while-revalidate.
