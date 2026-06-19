// Edge Function: share/<id> — serves an OG-tagged HTML page so social crawlers
// (Discord, X, WhatsApp, Telegram, Facebook) show a rich preview with the rank
// card, then redirects real humans to the SPA profile. Deploy with --no-verify-jwt.
// (The SPA on Lovable can't emit per-route OG meta — crawlers don't run JS.)

const BUCKET = "https://bklmwueojaftiedhwazp.supabase.co/storage/v1/object/public/rankings";
const FN = "https://bklmwueojaftiedhwazp.supabase.co/functions/v1";
const SITE = "https://riftladder.com";

const esc = (s: string) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function idFromUrl(url: URL): string {
  const q = url.searchParams.get("id");
  if (q) return q.trim();
  const seg = url.pathname.split("/").filter(Boolean).pop() || "";
  return seg === "share" ? "" : seg.trim();
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const id = idFromUrl(url);
  if (!id || !/^[\w-]{1,40}$/.test(id)) return new Response("bad id", { status: 400 });

  let handle = "Player", extra = "";
  try {
    const res = await fetch(`${BUCKET}/players/${id}.json`);
    if (res.ok) {
      const p = await res.json();
      handle = p.handle || handle;
      extra = p.provisional ? "" : ` · ELO ${p.rating}`;
    }
  } catch { /* fall back to generic copy */ }

  const profileUrl = `${SITE}/giocatore/${encodeURIComponent(id)}`;
  const ogImg = `${FN}/og/${encodeURIComponent(id)}.png`;
  const title = `${handle} — Riftbound ELO Ranking`;
  const desc = `${handle}'s competitive Riftbound profile${extra} — rank, record, palmarès and trophy cabinet on Riftladder.`;

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="canonical" href="${profileUrl}">
<meta property="og:type" content="profile">
<meta property="og:site_name" content="Riftladder">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${profileUrl}">
<meta property="og:image" content="${ogImg}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${ogImg}">
<meta http-equiv="refresh" content="0; url=${esc(profileUrl)}">
</head><body style="background:#0b0c12;color:#f1eee6;font-family:sans-serif">
<script>location.replace(${JSON.stringify(profileUrl)})</script>
<p><a href="${esc(profileUrl)}" style="color:#5b8cff">View ${esc(handle)} on Riftladder →</a></p>
</body></html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" },
  });
});
