# Riftladder share-card service (Deno Deploy)

`main.ts` is a single self-contained service with two public routes:

- `GET /og/<id>.png` — renders the 1200×630 player **rank card** PNG on-demand
  (resvg-wasm + Cinzel/Inter fonts from jsDelivr).
- `GET /share/<id>` — OG-tagged HTML preview (the card) that redirects humans to
  `https://riftladder.com/giocatore/<id>`. This is what the site's **Share** button links to.

It reads only the **public** rankings bucket, so it needs **no secrets**.
Hosted on **Deno Deploy** (free, GitHub login) — independent of the Lovable-managed Supabase.

## Deploy (one-time, ~2 min) — Git integration (recommended)

1. Go to **https://dash.deno.com** → sign in with **GitHub**.
2. **New Project** → **Deploy from GitHub repository**.
3. Repo: `gianmarco-pinto/riftbound-sardegna` · Branch: `main` · Entry point: `deno/main.ts`.
4. Set the project **name to `riftladder-cards`** (so the URL is `https://riftladder-cards.deno.dev`).
5. **Deploy**. Done — it auto-redeploys on every push to `main`.

> If the name `riftladder-cards` is taken, pick another and tell me the final URL —
> I'll update the Share button (one line).

### Alternative: Playground (no GitHub link)
dash.deno.com → **New Playground** → paste the contents of `main.ts` → rename the
project to `riftladder-cards` → it deploys to `https://riftladder-cards.deno.dev`.

## Verify
```bash
curl -s -o card.png "https://riftladder-cards.deno.dev/og/135798.png" && file card.png   # PNG 1200x630
curl -s "https://riftladder-cards.deno.dev/share/135798" | grep og:image
```
Then paste a `https://riftladder-cards.deno.dev/share/<id>` link in Discord/X to see the unfurl.

## Local test
```bash
deno run -A deno/main.ts   # serves on http://localhost:8000
```
