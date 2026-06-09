// Riftbound Ranking — static SPA. No dependencies. Reads data.json (generated
// from SQLite by src/build-site.mjs). Hash routing: #/ = leaderboard,
// #/p/<id> = player profile (with head-to-head).

const app = document.getElementById("app");
let DATA = null, byId = new Map(), matchesByPlayer = new Map();

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fdate = (d) => (d ? String(d).slice(0, 10) : "");

// outcome of a match for player pid: 'W' | 'L' | 'D'
function resultFor(m, pid) {
  if (m.winner === "draw") return "D";
  const meA = m.a === pid;
  const won = (m.winner === "A" && meA) || (m.winner === "B" && !meA);
  return won ? "W" : "L";
}
const oppOf = (m, pid) => (m.a === pid ? m.b : m.a);
const evName = (eid) => DATA.events[eid]?.name || "Evento";
const evWhere = (eid) => { const e = DATA.events[eid]; return e ? [e.store, e.city].filter(Boolean).join(" · ") : ""; };

async function load() {
  DATA = await (await fetch("data.json")).json();
  byId = new Map(DATA.players.map((p) => [p.id, p]));
  for (const m of DATA.matches) {
    for (const pid of [m.a, m.b]) {
      if (!matchesByPlayer.has(pid)) matchesByPlayer.set(pid, []);
      matchesByPlayer.get(pid).push(m);
    }
  }
  for (const arr of matchesByPlayer.values()) arr.sort((x, y) => String(y.date).localeCompare(String(x.date)));
  route();
}

window.addEventListener("hashchange", route);

function route() {
  const h = location.hash.replace(/^#\/?/, "");
  if (h.startsWith("p/")) renderPlayer(decodeURIComponent(h.slice(2)));
  else renderLeaderboard();
}

// ---------- Leaderboard ----------
let uiRegion = "", uiQuery = "", uiMinGames = 1;

function renderLeaderboard() {
  document.getElementById("subtitle").textContent = "Classifica giocatori · Sardegna";
  const regions = DATA.regions;
  let rows = DATA.players.filter((p) => p.games >= uiMinGames);
  if (uiRegion) rows = rows.filter((p) => p.regions.includes(uiRegion));
  if (uiQuery) rows = rows.filter((p) => p.handle.toLowerCase().includes(uiQuery.toLowerCase()));

  const optRegions = ['<option value="">Tutte le aree</option>']
    .concat(regions.map((r) => `<option value="${esc(r)}"${r === uiRegion ? " selected" : ""}>${esc(r)}</option>`)).join("");
  const GAMES_OPTS = [
    [1, "Almeno 1 partita giocata"],
    [5, "Almeno 5 partite giocate"],
    [10, "Almeno 10 partite giocate"],
    [25, "Almeno 25 partite giocate"],
  ];
  const optGames = GAMES_OPTS.map(([n, label]) => `<option value="${n}"${n === uiMinGames ? " selected" : ""}>${label}</option>`).join("");

  app.innerHTML = `
    <div class="controls">
      <select id="fRegion">${optRegions}</select>
      <select id="fGames">${optGames}</select>
      <input id="fQuery" placeholder="Cerca un giocatore…" value="${esc(uiQuery)}" />
    </div>
    <table>
      <thead><tr><th class="rank">#</th><th>Giocatore</th><th class="num">ELO</th><th class="num">Record</th><th class="num">Partite</th></tr></thead>
      <tbody>${rows.map((p, i) => `
        <tr data-id="${esc(p.id)}">
          <td class="rank num">${i + 1}</td>
          <td>${esc(p.handle)}${p.provisional ? '<span class="badge">provvisorio</span>' : ""}</td>
          <td class="num"><span class="elo">${p.rating}</span> <span class="rd">±${p.rd}</span></td>
          <td class="num">${p.wins}-${p.losses}-${p.draws}</td>
          <td class="num">${p.games}</td>
        </tr>`).join("") || `<tr><td colspan="5" class="nores">Nessun giocatore.</td></tr>`}
      </tbody>
    </table>
    <p class="foot">${DATA.counts.players} giocatori · ${DATA.counts.matches} partite · aggiornato ${fdate(DATA.generatedAt)}</p>`;

  document.getElementById("fRegion").onchange = (e) => { uiRegion = e.target.value; renderLeaderboard(); };
  document.getElementById("fGames").onchange = (e) => { uiMinGames = +e.target.value; renderLeaderboard(); };
  const q = document.getElementById("fQuery");
  q.oninput = (e) => { uiQuery = e.target.value; renderLeaderboard(); q2(); };
  function q2(){ const el=document.getElementById("fQuery"); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  app.querySelectorAll("tbody tr[data-id]").forEach((tr) =>
    tr.onclick = () => { location.hash = "#/p/" + encodeURIComponent(tr.dataset.id); });
}

// ---------- Player profile ----------
function ratingChart(series) {
  if (series.length < 2) return '<div class="muted" style="padding:8px">Storico insufficiente per il grafico.</div>';
  const W = 600, H = 160, pad = 24;
  const rs = series.map((s) => s.rating);
  const min = Math.min(...rs) - 20, max = Math.max(...rs) + 20;
  const x = (i) => pad + (i * (W - 2 * pad)) / (series.length - 1);
  const y = (r) => H - pad - ((r - min) * (H - 2 * pad)) / (max - min || 1);
  const pts = series.map((s, i) => `${x(i).toFixed(1)},${y(s.rating).toFixed(1)}`).join(" ");
  const dots = series.map((s, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(s.rating).toFixed(1)}" r="2.5" fill="#f0a020"><title>${esc(fdate(s.date))} · ${s.rating} (${esc(s.eventName)})</title></circle>`).join("");
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="#f0a020" stroke-width="2"/>
    ${dots}
    <text x="${pad}" y="14" fill="#8aa2bd" font-size="11">${max - 20}</text>
    <text x="${pad}" y="${H - 6}" fill="#8aa2bd" font-size="11">${min + 20}</text>
  </svg></div>`;
}

function renderPlayer(id, oppId = null) {
  const p = byId.get(id);
  if (!p) { app.innerHTML = `<a class="back" href="#/">← Classifica</a><p class="nores">Giocatore non trovato.</p>`; return; }
  document.getElementById("subtitle").textContent = p.handle;
  const ms = matchesByPlayer.get(id) || [];

  const bw = p.bestWin, wl = p.worstLoss;
  const recCard = (title, rec, cls) => rec
    ? `<div class="card"><h3>${title}</h3><div class="big ${cls}">${esc(rec.oppHandle)} <span class="muted">(${rec.oppRating})</span></div><div class="muted">${esc(rec.eventName)} · ${fdate(rec.date)}</div></div>`
    : `<div class="card"><h3>${title}</h3><div class="muted">—</div></div>`;

  // rivalries: aggregate this player's record against each opponent
  const tally = new Map();
  for (const m of ms) {
    const oid = oppOf(m, id);
    if (oid == null) continue;
    if (!tally.has(oid)) tally.set(oid, { oid, w: 0, l: 0, d: 0, g: 0 });
    const t = tally.get(oid); t.g++;
    const r = resultFor(m, id);
    if (r === "W") t.w++; else if (r === "L") t.l++; else t.d++;
  }
  const opps = [...tally.values()];
  const pickMax = (f) => opps.filter((o) => f(o) > 0).sort((a, b) => f(b) - f(a) || b.g - a.g)[0] || null;
  const worstOpp = pickMax((o) => o.l);                                   // most losses against
  const bestOpp = pickMax((o) => o.w);                                    // most wins against
  const mostOpp = opps.slice().sort((a, b) => b.g - a.g)[0] || null;      // most games played
  const nameOf = (oid) => byId.get(oid)?.handle || "?";
  const rivalCard = (title, o, line, cls) => o
    ? `<div class="card"><h3>${title}</h3><div class="big ${cls || ""}"><a href="#/p/${encodeURIComponent(o.oid)}">${esc(nameOf(o.oid))}</a></div><div class="muted">${line(o)}</div></div>`
    : `<div class="card"><h3>${title}</h3><div class="muted">—</div></div>`;

  // recent matches
  const recent = ms.slice(0, 15).map((m) => {
    const r = resultFor(m, id), o = byId.get(oppOf(m, id));
    const oh = o ? o.handle : "?";
    const rc = r === "W" ? "w" : r === "L" ? "l" : "d";
    return `<li><span><span class="res ${rc}">${r}</span> <a href="#/p/${encodeURIComponent(oppOf(m, id))}">${esc(oh)}</a></span>
      <span class="muted">${esc(evName(m.eventId))} · ${fdate(m.date)}</span></li>`;
  }).join("") || '<li class="muted">Nessuna partita.</li>';

  // head-to-head
  let h2hHtml = "";
  const opponents = [...new Set(ms.map((m) => oppOf(m, id)))]
    .map((oid) => byId.get(oid)).filter(Boolean)
    .sort((a, b) => a.handle.localeCompare(b.handle));
  const optsOpp = ['<option value="">— scegli avversario —</option>']
    .concat(opponents.map((o) => `<option value="${esc(o.id)}"${o.id === oppId ? " selected" : ""}>${esc(o.handle)}</option>`)).join("");
  if (oppId && byId.get(oppId)) {
    const h = ms.filter((m) => oppOf(m, id) === oppId);
    let w = 0, l = 0, d = 0;
    for (const m of h) { const r = resultFor(m, id); if (r === "W") w++; else if (r === "L") l++; else d++; }
    h2hHtml = `<div class="big">${w}-${l}-${d} <span class="muted">vs ${esc(byId.get(oppId).handle)}</span></div>
      <ul class="reslist">${h.map((m) => { const r = resultFor(m, id); const rc = r === "W" ? "w" : r === "L" ? "l" : "d";
        return `<li><span class="res ${rc}">${r}</span><span class="muted">${esc(evName(m.eventId))} · ${fdate(m.date)}</span></li>`; }).join("")}</ul>`;
  }

  app.innerHTML = `
    <a class="back" href="#/">← Classifica</a>
    <div class="phead">
      <h2>${esc(p.handle)}</h2>
      <span class="pbig">${p.rating}</span><span class="rd">±${p.rd}${p.provisional ? '<span class="badge">provvisorio</span>' : ""}</span>
    </div>
    <div class="muted">Record ${p.wins}-${p.losses}-${p.draws} · ${p.games} partite · aree: ${p.regions.map(esc).join(", ") || "—"}</div>
    ${ratingChart(p.series)}
    <div class="grid">
      ${recCard("Miglior vittoria", bw, "w")}
      ${recCard("Peggior sconfitta", wl, "l")}
    </div>
    <div class="grid">
      ${rivalCard("Peggior avversario", worstOpp, (o) => `${o.l} sconfitte · ${o.w}-${o.l}-${o.d}`, "l")}
      ${rivalCard("Miglior avversario", bestOpp, (o) => `${o.w} vittorie · ${o.w}-${o.l}-${o.d}`, "w")}
      ${rivalCard("Più sfide", mostOpp, (o) => `${o.g} partite · ${o.w}-${o.l}-${o.d}`)}
    </div>
    <div class="card"><h3>Scontri diretti</h3>
      <select id="oppSel">${optsOpp}</select>
      <div id="h2h" style="margin-top:10px">${h2hHtml}</div>
    </div>
    <div class="card" style="margin-top:12px"><h3>Ultime partite</h3><ul class="reslist">${recent}</ul></div>`;

  document.getElementById("oppSel").onchange = (e) => renderPlayer(id, e.target.value || null);
}

load();
