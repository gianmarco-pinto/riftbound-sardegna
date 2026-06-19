// Edge Function: og/<id>.png — renders the Riftladder shareable "rank card" PNG
// on-demand from a player's public JSON shard. Deploy with --no-verify-jwt.
import { Resvg, initWasm } from "https://esm.sh/@resvg/resvg-wasm@2.6.2";
import { buildCardSVG } from "../_shared/card.ts";

const BUCKET = "https://bklmwueojaftiedhwazp.supabase.co/storage/v1/object/public/rankings";
const FONT_INTER = "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/inter/Inter%5Bopsz,wght%5D.ttf";
const FONT_CINZEL = "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/cinzel/Cinzel%5Bwght%5D.ttf";

// init once per cold start
let wasmReady: Promise<unknown> | null = null;
const initOnce = () => (wasmReady ??= initWasm(fetch("https://esm.sh/@resvg/resvg-wasm@2.6.2/index_bg.wasm")));
let fontsReady: Promise<Uint8Array[]> | null = null;
const fonts = () =>
  (fontsReady ??= Promise.all(
    [FONT_INTER, FONT_CINZEL].map((u) => fetch(u).then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b))),
  ));

function idFromUrl(url: URL): string {
  const q = url.searchParams.get("id");
  if (q) return q.trim();
  const seg = url.pathname.split("/").filter(Boolean).pop() || "";
  if (seg === "og") return "";
  return seg.replace(/\.png$/i, "").trim();
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const id = idFromUrl(url);
  if (!id || !/^[\w-]{1,40}$/.test(id)) return new Response("bad id", { status: 400 });
  try {
    const res = await fetch(`${BUCKET}/players/${id}.json`);
    if (!res.ok) return new Response("player not found", { status: 404 });
    const player = await res.json();

    await initOnce();
    const [inter, cinzel] = await fonts();
    const svg = buildCardSVG(player);
    const resvg = new Resvg(svg, {
      font: { fontBuffers: [inter, cinzel], defaultFontFamily: "Inter", loadSystemFonts: false },
      fitTo: { mode: "width", value: 1200 },
    });
    const png = resvg.render().asPng();

    return new Response(png, {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
        "access-control-allow-origin": "*",
      },
    });
  } catch (e) {
    console.error("og render error", id, e);
    return new Response("render error", { status: 500 });
  }
});
