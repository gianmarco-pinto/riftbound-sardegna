// Riftladder share-card service — single self-contained Deno entry point.
// Hosted on Deno Deploy (free, user-owned). Reads only the PUBLIC rankings
// bucket, so it needs no secrets. Two routes:
//   GET /og/<id>.png  → renders the 1200x630 player "rank card" PNG
//   GET /share/<id>   → OG-tagged HTML preview (the card) + redirect to the SPA
// Pasteable into a Deno Deploy playground, or deployed from this repo (entry: deno/main.ts).
import { Resvg, initWasm } from "https://esm.sh/@resvg/resvg-wasm@2.6.2";

const BUCKET = "https://bklmwueojaftiedhwazp.supabase.co/storage/v1/object/public/rankings";
const SITE = "https://riftladder.com";
const FONT_INTER = "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/inter/Inter%5Bopsz,wght%5D.ttf";
const FONT_CINZEL = "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/cinzel/Cinzel%5Bwght%5D.ttf";

// ---------- cold-start singletons ----------
let wasmReady: Promise<unknown> | null = null;
const initOnce = () => (wasmReady ??= initWasm(fetch("https://esm.sh/@resvg/resvg-wasm@2.6.2/index_bg.wasm")));
let fontsReady: Promise<Uint8Array[]> | null = null;
const fonts = () => (fontsReady ??= Promise.all(
  [FONT_INTER, FONT_CINZEL].map((u) => fetch(u).then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b))),
));

// ---------- card SVG builder (uniform, English, no other players' names) ----------
const C = {
  bg0: "#090a10", bg1: "#13111d", bg2: "#1a1730", panelBorder: "#2c3042", band: "#0c0d17", bandBorder: "#262a3a",
  fg: "#f1eee6", muted: "#959bb0", faint: "#5a6072", glow: "#5b8cff", glowSoft: "#bcd0ff",
  gold: "#E0A526", goldSoft: "#f0ca68", silver: "#C2C8D2", bronze: "#C17A3F", green: "#34d399", red: "#f06a6a",
};
const METAL: Record<string, { f: string; d: string }> = { gold: { f: "#E0A526", d: "#8A5E12" }, silver: { f: "#C2C8D2", d: "#6B7280" }, bronze: { f: "#C17A3F", d: "#7A4A22" } };
const DISPLAY = "Cinzel, serif";
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const clip = (s: string, n: number) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s ?? "");
const nf = (n: number) => Number(n).toLocaleString("en-US");
const CONT: Record<string, string> = { eu: "Europe", na: "North America", sa: "South America", as: "Asia", af: "Africa", oc: "Oceania", global: "World", sardegna: "Sardinia" };
const isCont = (k: string) => ["eu", "na", "sa", "as", "af", "oc"].includes(k);
const PRIO: Record<string, number> = { global: 0, sardegna: 9 };
function scopeName(s: string) { if (CONT[s]) return CONT[s]; try { return new Intl.DisplayNames(["en"], { type: "region" }).of(s.toUpperCase()) || s.toUpperCase(); } catch { return s.toUpperCase(); } }
function fmtDate(iso: string) { try { return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); } catch { return ""; } }
const ord = (n: number) => `${n}${(["th", "st", "nd", "rd"] as Record<number, string>)[n] || "th"}`;
const TIER_NAME: Record<number, string> = { 1: "Pre-Rift", 2: "Nexus", 3: "Skirmish", 4: "Regional Qualifier", 5: "Regional Championship" };
const LUCIDE: Record<string, string[]> = {
  trophy: ['M10 14.66v1.626a2 2 0 0 1-.976 1.696A5 5 0 0 0 7 21.978', 'M14 14.66v1.626a2 2 0 0 0 .976 1.696A5 5 0 0 1 17 21.978', 'M18 9h1.5a1 1 0 0 0 0-5H18', 'M4 22h16', 'M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z', 'M6 9H4.5a1 1 0 0 1 0-5H6'],
  crown: ['M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z', 'M5 21h14'],
  medal: ['M7.21 15 2.66 7.14a2 2 0 0 1 .13-2.2L4.4 2.8A2 2 0 0 1 6 2h12a2 2 0 0 1 1.6.8l1.6 2.14a2 2 0 0 1 .14 2.2L16.79 15', 'M11 12 5.12 2.2', 'm13 12 5.88-9.8', 'M8 7h8', 'M12 18v-2h-.5', 'M12 17 a5 5 0 1 0 0.001 0'],
  star: ['M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z'],
};
function lucide(name: string, x: number, y: number, size: number, color: string, fill = "none", sw = 2) {
  const s = size / 24;
  return `<g transform="translate(${x},${y}) scale(${s})">${LUCIDE[name].map((d) => `<path d="${d}" fill="${fill}" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`).join("")}</g>`;
}
function coccarda(x: number, y: number, size: number, f: string, d: string) { const s = size / 24; return `<g transform="translate(${x},${y}) scale(${s})"><polygon points="9,12.5 12,12.5 11,22 9.5,20 7.5,22" fill="${d}"/><polygon points="12,12.5 15,12.5 16.5,22 14.5,20 13,22" fill="${d}"/><circle cx="12" cy="8" r="6" fill="${f}" stroke="${d}" stroke-width="1.2"/><circle cx="12" cy="8" r="2.2" fill="${d}"/></g>`; }
function targa(x: number, y: number, size: number, f: string, d: string) { const s = size / 24; return `<g transform="translate(${x},${y}) scale(${s})"><rect x="3" y="5" width="18" height="14" rx="2" fill="${f}" stroke="${d}" stroke-width="1.2"/><rect x="5.5" y="7.5" width="13" height="9" rx="1" fill="none" stroke="${d}" stroke-width="1"/><line x1="8" y1="11" x2="16" y2="11" stroke="${d}" stroke-width="1.3"/><line x1="9" y1="13.5" x2="15" y2="13.5" stroke="${d}" stroke-width="1"/></g>`; }
function tierIcon(tier: number, x: number, y: number, size: number, metal?: string) {
  const f = metal ? METAL[metal].f : C.faint, d = metal ? METAL[metal].d : "#3a3f4f";
  if (tier === 1) return coccarda(x, y, size, f, d);
  if (tier === 2) return targa(x, y, size, f, d);
  if (tier === 5) return lucide("crown", x, y, size, f);
  if (tier === 4) return lucide("trophy", x, y, size, f);
  return lucide("medal", x, y, size, f);
}
function buildCardSVG(p: any) {
  const ranked = (p.positions || []).filter((x: any) => x.elo != null)
    .sort((a: any, b: any) => (PRIO[a.scope] ?? (isCont(a.scope) ? 5 : 2)) - (PRIO[b.scope] ?? (isCont(b.scope) ? 5 : 2))).slice(0, 3);
  const world = ranked.find((r: any) => r.scope === "global");
  const wr = p.games ? Math.round((p.wins / p.games) * 100) : 0;
  const major = (p.majors || []).slice().sort((a: any, b: any) => a.rank - b.rank || b.participants - a.participants)[0];
  const entries = (p.palmares || []).map((t: any) => ({ tier: t.tier, name: TIER_NAME[t.tier] || `Tier ${t.tier}`, gold: t.first || 0, silver: t.second || 0, bronze: t.third || 0 }))
    .filter((e: any) => e.gold + e.silver + e.bronze > 0).sort((a: any, b: any) => b.tier - a.tier).slice(0, 4);
  let cx = 64;
  const chips = ranked.map((r: any) => {
    const txt = `#${nf(r.elo)}  ${scopeName(r.scope).toUpperCase()}`;
    const w = 36 + txt.length * 12.4; const hot = r.scope === "global";
    const g = `<g transform="translate(${cx},230)"><rect width="${w}" height="44" rx="22" fill="${hot ? C.glow : "none"}" fill-opacity="${hot ? 0.14 : 1}" stroke="${hot ? C.glow : C.panelBorder}" stroke-opacity="${hot ? 0.7 : 1}"/><text x="${w / 2}" y="29" text-anchor="middle" font-family="Inter" font-weight="700" font-size="19" fill="${hot ? C.glow : C.muted}">${esc(txt)}</text></g>`;
    cx += w + 12; return g;
  }).join("");
  const MEDAL_C: Record<string, string> = { gold: C.gold, silver: C.silver, bronze: C.bronze };
  function entrySVG(e: any, x: number, yTop: number) {
    const best = e.gold ? "gold" : e.silver ? "silver" : "bronze";
    const parts = [["gold", e.gold], ["silver", e.silver], ["bronze", e.bronze]].filter(([, n]) => (n as number) > 0) as [string, number][];
    let dx = 0;
    const dots = parts.map(([metal, n]) => { const g = `<circle cx="${64 + dx + 7}" cy="${yTop + 60}" r="8" fill="${MEDAL_C[metal]}"/><text x="${64 + dx + 22}" y="${yTop + 67}" font-family="Inter" font-weight="700" font-size="21" fill="${C.fg}">${n}</text>`; dx += 22 + 16 + String(n).length * 13 + 14; return g; }).join("");
    return `${tierIcon(e.tier, x, yTop + 16, 46, best)}<text x="${x + 64}" y="${yTop + 30}" font-family="Inter" font-weight="700" font-size="20" fill="${C.fg}">${esc(e.name)}</text><g transform="translate(${x},0)">${dots}</g>`;
  }
  let cabinet: string;
  if (entries.length) {
    const colW = Math.min(360, Math.floor(1040 / entries.length));
    cabinet = entries.map((e: any, i: number) => { const x = 80 + i * colW; const sep = i > 0 ? `<line x1="${x - 18}" y1="468" x2="${x - 18}" y2="540" stroke="${C.bandBorder}"/>` : ""; return sep + entrySVG(e, x, 458); }).join("");
  } else { cabinet = `<text x="80" y="516" font-family="Inter" font-weight="600" font-size="23" fill="${C.faint}">No podium finishes yet — climbing the ladder</text>`; }
  let feat = "";
  if (major) {
    feat = `${lucide("star", 64, 352, 28, C.gold, C.gold, 1.5)}<text x="104" y="374" font-family="Inter" font-size="24" fill="${C.fg}"><tspan font-weight="800" fill="${C.goldSoft}">${esc(ord(major.rank))} place</tspan> · ${esc(clip(major.eventName.replace(/^Riftbound /, ""), 38))} <tspan fill="${C.faint}" font-size="19">· ${nf(major.participants)} players</tspan></text>`;
  } else {
    const peak = Math.max(p.provisional ? 0 : (p.rating || 0), ...((p.series || []).map((s: any) => s.rating || 0)));
    if (peak > 0) feat = `${lucide("star", 64, 352, 28, C.glow)}<text x="104" y="374" font-family="Inter" font-size="23" fill="${C.muted}">Peak ELO <tspan font-weight="800" fill="${C.fg}">${nf(peak)}</tspan></text>`;
  }
  const rating = p.provisional ? "—" : nf(p.rating);
  return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.bg0}"/><stop offset="0.55" stop-color="${C.bg1}"/><stop offset="1" stop-color="${C.bg2}"/></linearGradient>
    <radialGradient id="g1" cx="0.82" cy="0" r="0.75"><stop offset="0" stop-color="${C.glow}" stop-opacity="0.26"/><stop offset="1" stop-color="${C.glow}" stop-opacity="0"/></radialGradient>
    <radialGradient id="g2" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${C.glow}" stop-opacity="0.40"/><stop offset="1" stop-color="${C.glow}" stop-opacity="0"/></radialGradient>
    <linearGradient id="num" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="0.55" stop-color="${C.glowSoft}"/><stop offset="1" stop-color="${C.glow}"/></linearGradient>
    <linearGradient id="wm" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.05"/><stop offset="1" stop-color="#ffffff" stop-opacity="0.01"/></linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/><rect width="1200" height="630" fill="url(#g1)"/><rect x="0" y="0" width="1200" height="6" fill="${C.glow}"/>
  <g opacity="0.9">${lucide("trophy", 905, 132, 220, "url(#wm)", "url(#wm)", 1)}</g>
  <text x="64" y="84" font-family="${DISPLAY}" font-weight="700" font-size="30" letter-spacing="2" fill="${C.fg}">RIFT<tspan fill="${C.glow}">LADDER</tspan></text>
  <text x="1136" y="84" text-anchor="end" font-family="Inter" font-weight="600" font-size="18" letter-spacing="3" fill="${C.muted}">RIFTBOUND · WORLD ELO RANKING</text>
  <text x="64" y="190" font-family="${DISPLAY}" font-weight="800" font-size="64" fill="${C.fg}">${esc(clip(p.handle, 16))}</text>
  ${chips}
  <text x="64" y="312" font-family="Inter" font-size="25" fill="${C.fg}"><tspan font-weight="700" fill="${C.green}">${p.wins}W</tspan><tspan fill="${C.faint}">  ·  </tspan><tspan font-weight="700" fill="${C.red}">${p.losses}L</tspan><tspan fill="${C.faint}">  ·  </tspan><tspan font-weight="700" fill="${C.muted}">${p.draws}D</tspan><tspan fill="${C.faint}">    </tspan><tspan font-weight="700">${wr}%</tspan><tspan fill="${C.muted}"> winrate</tspan><tspan fill="${C.faint}">  ·  ${nf(p.games)} games</tspan></text>
  ${feat}
  <ellipse cx="974" cy="190" rx="180" ry="118" fill="url(#g2)"/>
  <text x="974" y="116" text-anchor="middle" font-family="${DISPLAY}" font-weight="700" font-size="22" letter-spacing="6" fill="${C.muted}">ELO</text>
  <text x="974" y="226" text-anchor="middle" font-family="Inter" font-weight="800" font-size="124" fill="url(#num)">${rating}</text>
  <text x="974" y="272" text-anchor="middle" font-family="Inter" font-size="22" fill="${C.muted}">${p.provisional ? "PROVISIONAL" : "± " + p.rd + " · Glicko-2"}</text>
  ${world ? `<g transform="translate(864,298)"><rect width="220" height="44" rx="22" fill="${C.gold}" fill-opacity="0.13" stroke="${C.gold}" stroke-opacity="0.5"/><text x="110" y="29" text-anchor="middle" font-family="Inter" font-weight="800" font-size="19" fill="${C.goldSoft}">WORLD #${nf(world.elo)}</text></g>` : ""}
  <rect x="48" y="402" width="1104" height="172" rx="18" fill="${C.band}" fill-opacity="0.9" stroke="${C.bandBorder}"/>
  <text x="80" y="438" font-family="Inter" font-weight="700" font-size="17" letter-spacing="4" fill="${C.muted}">TROPHY CABINET</text>
  <line x1="80" y1="450" x2="1120" y2="450" stroke="${C.bandBorder}"/>
  ${cabinet}
  <text x="64" y="606" font-family="${DISPLAY}" font-weight="700" font-size="22" fill="${C.fg}">riftladder<tspan fill="${C.glow}">.com</tspan></text>
  <text x="1136" y="606" text-anchor="end" font-family="Inter" font-size="19" fill="${C.faint}">updated ${fmtDate(p.lastDate || new Date().toISOString())}</text>
</svg>`;
}

// ---------- request handling ----------
const lastSeg = (path: string) => path.split("/").filter(Boolean).pop() || "";
async function getPlayer(id: string) {
  const res = await fetch(`${BUCKET}/players/${id}.json`);
  if (!res.ok) return null;
  return res.json();
}
function shareHtml(id: string, p: any, origin: string) {
  const profileUrl = `${SITE}/giocatore/${encodeURIComponent(id)}`;
  const ogImg = `${origin}/og/${encodeURIComponent(id)}.png`;
  const handle = p?.handle || "Player";
  const extra = p && !p.provisional ? ` · ELO ${p.rating}` : "";
  const title = `${handle} — Riftbound ELO Ranking`;
  const desc = `${handle}'s competitive Riftbound profile${extra} — rank, record, palmarès and trophy cabinet on Riftladder.`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="canonical" href="${profileUrl}">
<meta property="og:type" content="profile"><meta property="og:site_name" content="Riftladder">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${profileUrl}"><meta property="og:image" content="${ogImg}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${ogImg}">
<meta http-equiv="refresh" content="0; url=${esc(profileUrl)}"></head>
<body style="background:#0b0c12;color:#f1eee6;font-family:sans-serif"><script>location.replace(${JSON.stringify(profileUrl)})</script>
<p><a href="${esc(profileUrl)}" style="color:#5b8cff">View ${esc(handle)} on Riftladder →</a></p></body></html>`;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const route = parts[0];
  const idRaw = url.searchParams.get("id") || (parts.length > 1 ? lastSeg(url.pathname) : "");
  const id = (idRaw || "").replace(/\.png$/i, "").trim();

  if (route === "og") {
    if (!/^[\w-]{1,40}$/.test(id)) return new Response("bad id", { status: 400 });
    try {
      const p = await getPlayer(id);
      if (!p) return new Response("player not found", { status: 404 });
      await initOnce();
      const [inter, cinzel] = await fonts();
      const resvg = new Resvg(buildCardSVG(p), { font: { fontBuffers: [inter, cinzel], defaultFontFamily: "Inter", loadSystemFonts: false }, fitTo: { mode: "width", value: 1200 } });
      return new Response(resvg.render().asPng(), { headers: { "content-type": "image/png", "cache-control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800", "access-control-allow-origin": "*" } });
    } catch (e) { console.error("og error", id, e); return new Response("render error", { status: 500 }); }
  }

  if (route === "share") {
    if (!/^[\w-]{1,40}$/.test(id)) return new Response("bad id", { status: 400 });
    const p = await getPlayer(id).catch(() => null);
    return new Response(shareHtml(id, p, url.origin), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } });
  }

  // root / health
  return new Response("Riftladder card service. Use /og/<id>.png or /share/<id>.", { headers: { "content-type": "text/plain" } });
});
