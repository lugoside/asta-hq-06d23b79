// app.js — logica dell'interfaccia. Collega dati (players.json) + engine.js + DOM.
import { DEFAULT_CONFIG, ROLES, MY_TEAM, computeBoard, leagueTotals } from "./engine.js";

// ---------------------------------------------------------------------------
// Stato + persistenza
// ---------------------------------------------------------------------------
const LS = {
  config: "fa_config", purchases: "fa_purchases", fav: "fa_favorites",
  players: "fa_players_cache", meta: "fa_meta_cache",
};
const RUOLO_NOME = { P: "Portiere", D: "Difensore", C: "Centrocampista", A: "Attaccante" };

const defaultConfig = () => ({
  numTeams: 10,
  budgetPerTeam: 500,
  roster: { ...DEFAULT_CONFIG.roster },
  splitPct: { P: 8, D: 14, C: 28, A: 50 },
  concentration: DEFAULT_CONFIG.concentration,
  strappo: DEFAULT_CONFIG.strappo,
  myName: "IO",
  opponents: Array.from({ length: 9 }, (_, i) => `Avv ${i + 1}`),
});

let CONFIG = load(LS.config, defaultConfig());
let PURCHASES = load(LS.purchases, []);
let FAVORITES = new Set(load(LS.fav, []));
let PLAYERS = [];
let META = {};
let BOARD = null;
let selectedId = null;
const ui = { screen: "asta", role: "ALL", sort: "consigliato", onlyFav: false, hideTaken: false, searchL: "" };

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }
function persist() {
  save(LS.config, CONFIG); save(LS.purchases, PURCHASES); save(LS.fav, [...FAVORITES]);
}

// config normalizzata per l'engine (splitPct → budgetSplit che somma 1)
function effectiveConfig() {
  const p = CONFIG.splitPct;
  const tot = p.P + p.D + p.C + p.A || 1;
  return {
    numTeams: CONFIG.numTeams,
    budgetPerTeam: CONFIG.budgetPerTeam,
    roster: CONFIG.roster,
    budgetSplit: { P: p.P / tot, D: p.D / tot, C: p.C / tot, A: p.A / tot },
    concentration: CONFIG.concentration,
    strappo: CONFIG.strappo,
  };
}

function teamList() {
  return [
    { id: MY_TEAM, name: CONFIG.myName || "IO", isMe: true },
    ...CONFIG.opponents.map((n) => ({ id: n, name: n, isMe: false })),
  ];
}

// ---------------------------------------------------------------------------
// Caricamento dati (network-first con fallback su cache locale)
// ---------------------------------------------------------------------------
async function loadData(forceNetwork = false) {
  try {
    const bust = forceNetwork ? `?ts=${Date.now()}` : "";
    const [pj, mj] = await Promise.all([
      fetch(`data/players.json${bust}`, { cache: forceNetwork ? "reload" : "default" }).then((r) => r.json()),
      fetch(`data/players.meta.json${bust}`, { cache: forceNetwork ? "reload" : "default" }).then((r) => r.json()).catch(() => ({})),
    ]);
    PLAYERS = pj; META = mj;
    save(LS.players, pj); save(LS.meta, mj);
  } catch (e) {
    PLAYERS = load(LS.players, []); META = load(LS.meta, {});
    if (!PLAYERS.length) throw e;
    toast("Offline: uso l'ultimo listone salvato");
  }
}

// ---------------------------------------------------------------------------
// Ricalcolo + render
// ---------------------------------------------------------------------------
function recompute() {
  BOARD = computeBoard(PLAYERS, PURCHASES, effectiveConfig());
}
const boardPlayer = (id) => BOARD?.players.find((p) => p.id === id);

function renderAll() {
  renderDataChip();
  renderBudgetBar();
  if (ui.screen === "asta") renderAsta();
  if (ui.screen === "listone") renderListone();
  if (ui.screen === "squadre") renderSquadre();
  if (ui.screen === "impostazioni") renderImpostazioni();
}

function renderDataChip() {
  const chip = document.getElementById("dataChip");
  const label = META.fonteAggiornata ? `listone ${META.fonteAggiornata}` : `agg. ${fmtScarico()}`;
  chip.innerHTML = (META.isDemo ? "⚠ DATI DEMO<br>" : "") + label;
  chip.classList.toggle("demo", !!META.isDemo);
}
// data/ora dell'ultimo scaricamento (quando è stato generato players.json)
function fmtScarico() {
  const d = META.aggiornato ? new Date(META.aggiornato) : null;
  return d ? d.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit" }) + " " +
    d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : "—";
}

function renderBudgetBar() {
  const bar = document.getElementById("budgetBar");
  bar.style.display = ui.screen === "asta" ? "flex" : "none";
  if (ui.screen !== "asta" || !BOARD?.me) return;
  document.getElementById("myBudget").textContent = BOARD.me.budgetLeft;
  const s = BOARD.me.slotsRemaining;
  document.getElementById("mySlots").innerHTML = ROLES
    .map((r) => `<span class="slot ${r}">${r} <b>${s[r]}</b></span>`)
    .join("");
}

// ---- ASTA ----
function renderAsta() {
  const card = document.getElementById("calledCard");
  const p = selectedId ? boardPlayer(selectedId) : null;
  if (!p) {
    card.className = "called empty";
    card.textContent = "Cerca un giocatore per vedere il prezzo consigliato.";
  } else {
    card.className = "called";
    const semTxt = {
      verde: "🟢 Occasione — alla tua portata",
      giallo: "🟡 Prezzo di mercato equo",
      rosso: !p.needRole ? "🔴 Ruolo già completo per te" : "🔴 Oltre il tuo budget utile",
      preso: `✔ Preso da ${teamName(p.takenBy)} a ${p.takenPrice}`,
    }[p.semaforo];
    const semClass = p.semaforo === "preso" ? "giallo" : p.semaforo;
    card.innerHTML = `
      <div class="top">
        <span class="rp ${p.ruolo}">${p.ruolo}</span>
        <div class="grow">
          <div class="nome">${esc(p.nome)}</div>
          <div class="sub">${esc(p.squadra)} · ${RUOLO_NOME[p.ruolo]} · valore ${p.valoreBase}</div>
        </div>
        <span class="tier ${p.tier}">${p.tier}</span>
      </div>
      <div class="price-grid">
        <div class="box"><div class="v big">${p.prezzoConsigliato}</div><div class="l">consigliato</div></div>
        <div class="box"><div class="v">${p.prezzoMax}</div><div class="l">max strappo</div></div>
        <div class="box"><div class="v">${BOARD.me.maxBid}</div><div class="l">tuo max</div></div>
      </div>
      <div class="semaforo ${semClass}"><span class="dot"></span>${semTxt}</div>
      ${p.taken ? `<button class="btn ghost full" data-undo="${p.id}">↩ Annulla acquisto</button>` : `
      <div class="buy-row">
        <button class="step" data-step="-1">−</button>
        <input id="priceInput" type="number" inputmode="numeric" min="1" value="${Math.max(1, p.prezzoConsigliato)}" />
        <button class="step" data-step="1">+</button>
      </div>
      <select class="opp-select mini-select" id="oppSelect" style="width:100%">
        ${CONFIG.opponents.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("")}
      </select>
      <div class="buy-actions">
        <button class="btn me" data-buy="me">✓ Preso da ${esc(CONFIG.myName || "IO")}</button>
        <button class="btn opp" data-buy="opp">Preso da avversario</button>
      </div>`}
    `;
  }
  renderRecent();
}

function renderRecent() {
  const el = document.getElementById("recentList");
  if (!PURCHASES.length) { el.innerHTML = `<div class="row"><span class="meta">Nessun acquisto ancora.</span></div>`; return; }
  el.innerHTML = PURCHASES.slice(-8).reverse().map((pu) => {
    const pl = PLAYERS.find((x) => x.id === pu.playerId);
    if (!pl) return "";
    const idx = PURCHASES.lastIndexOf(pu);
    return `<div class="row">
      <span class="rp ${pl.ruolo}">${pl.ruolo}</span>
      <div class="grow"><div class="nome">${esc(pl.nome)}</div>
        <div class="meta">${teamName(pu.team)}</div></div>
      <span class="price">${pu.price}</span>
      <button class="star" data-undoidx="${idx}">✕</button>
    </div>`;
  }).join("");
}

// ---- LISTONE ----
function renderListone() {
  const el = document.getElementById("listoneList");
  let list = BOARD.players.slice();
  if (ui.role !== "ALL") list = list.filter((p) => p.ruolo === ui.role);
  if (ui.onlyFav) list = list.filter((p) => FAVORITES.has(p.id));
  if (ui.hideTaken) list = list.filter((p) => !p.taken);
  if (ui.searchL) { const q = ui.searchL.toLowerCase(); list = list.filter((p) => p.nome.toLowerCase().includes(q) || p.squadra.toLowerCase().includes(q)); }
  const cmp = {
    consigliato: (a, b) => b.prezzoConsigliato - a.prezzoConsigliato,
    valore: (a, b) => b.valoreBase - a.valoreBase,
    qi: (a, b) => b.qi - a.qi,
    nome: (a, b) => a.nome.localeCompare(b.nome),
  }[ui.sort];
  list.sort(cmp);
  el.innerHTML = list.slice(0, 300).map((p) => `
    <div class="row ${p.taken ? "taken" : ""}" data-pick="${p.id}">
      <button class="star ${FAVORITES.has(p.id) ? "on" : ""}" data-fav="${p.id}">${FAVORITES.has(p.id) ? "★" : "☆"}</button>
      <span class="rp ${p.ruolo}">${p.ruolo}</span>
      <div class="grow"><div class="nome">${esc(p.nome)}</div>
        <div class="meta">${esc(p.squadra)} · ${p.tier} · val ${p.valoreBase}${p.taken ? " · preso " + teamName(p.takenBy) : ""}</div></div>
      <span class="price">${p.taken ? p.takenPrice : p.prezzoConsigliato}</span>
    </div>`).join("") || `<div class="row"><span class="meta">Nessun giocatore.</span></div>`;
}

// ---- SQUADRE ----
function renderSquadre() {
  const el = document.getElementById("teamsList");
  const byId = new Map(BOARD.teams.map((t) => [t.id, t]));
  el.innerHTML = teamList().map((t) => {
    const s = byId.get(t.id) || { budgetLeft: CONFIG.budgetPerTeam, spent: 0, slotsRemaining: { ...CONFIG.roster }, count: 0 };
    const pct = Math.max(0, Math.min(100, (s.budgetLeft / CONFIG.budgetPerTeam) * 100));
    return `<div class="team">
      <div class="hd">
        <span class="nm ${t.isMe ? "me" : ""}">${esc(t.name)}</span>
        <span class="bud">${s.budgetLeft} <small>/ ${CONFIG.budgetPerTeam} · ${s.count} giocatori</small></span>
      </div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="slotline">${ROLES.map((r) => `<span class="slot ${r}">${r} ${s.slotsRemaining[r]}</span>`).join("")}</div>
    </div>`;
  }).join("");
}

// ---- IMPOSTAZIONI ----
function renderImpostazioni() {
  document.getElementById("metaInfo").innerHTML =
    `Stagione <b>${META.stagione || "?"}</b> · ${META.numGiocatori || PLAYERS.length} giocatori · ` +
    (META.isDemo ? "<b style='color:var(--giallo)'>dati DEMO</b>" : "listone reale") +
    (META.fonteAggiornata ? `<br>📅 Listone aggiornato dalla fonte: <b>${esc(META.fonteAggiornata)}</b>` : "") +
    `<br>⬇ Ultimo scaricamento: ${fmtScarico()}` +
    `<br>Fonte: ${esc(META.fonte || "—")}`;

  const sp = document.getElementById("splitSettings");
  sp.innerHTML = ROLES.map((r) => `
    <div class="setting">
      <label>${RUOLO_NOME[r]} <span class="val" id="splitVal${r}">${CONFIG.splitPct[r]}%</span></label>
      <input type="range" min="0" max="70" value="${CONFIG.splitPct[r]}" data-split="${r}" />
    </div>`).join("");
  updateSplitSum();

  document.getElementById("myName").value = CONFIG.myName;
  document.getElementById("oppSettings").innerHTML = CONFIG.opponents.map((o, i) => `
    <div class="setting" style="padding:6px 0"><input type="text" data-opp="${i}" value="${esc(o)}" /></div>`).join("");
}
function updateSplitSum() {
  const p = CONFIG.splitPct; const tot = p.P + p.D + p.C + p.A;
  const el = document.getElementById("splitSum");
  if (el) el.innerHTML = `Totale ${tot}% (normalizzato automaticamente). In crediti: ` +
    ROLES.map((r) => `${r} ~${Math.round((p[r] / tot) * leagueTotals(effectiveConfig()).totalBudget)}`).join(" · ");
}

// ---------------------------------------------------------------------------
// Azioni
// ---------------------------------------------------------------------------
function selectPlayer(id) {
  selectedId = id;
  setScreen("asta");
  const s = document.getElementById("search"); if (s) s.value = "";
  document.getElementById("searchResults").innerHTML = "";
  renderAll();
}

function recordPurchase(team) {
  const p = boardPlayer(selectedId); if (!p) return;
  const input = document.getElementById("priceInput");
  const price = Math.max(1, Math.round(Number(input?.value) || p.prezzoConsigliato));
  PURCHASES.push({ playerId: selectedId, price, team });
  persist(); recompute();
  toast(`${p.nome} → ${teamName(team)} a ${price}`);
  selectedId = null;
  renderAll();
}
function undoPurchaseIdx(idx) {
  if (idx >= 0 && idx < PURCHASES.length) {
    const pu = PURCHASES[idx]; const pl = PLAYERS.find((x) => x.id === pu.playerId);
    PURCHASES.splice(idx, 1); persist(); recompute();
    toast(`Annullato: ${pl ? pl.nome : "acquisto"}`);
    renderAll();
  }
}
function undoPurchaseByPlayer(id) {
  const idx = PURCHASES.map((p) => p.playerId).lastIndexOf(id);
  undoPurchaseIdx(idx);
}

function setScreen(name) {
  ui.screen = name;
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === `screen-${name}`));
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.screen === name));
  renderAll();
}

function teamName(id) {
  if (id === MY_TEAM) return CONFIG.myName || "IO";
  return id;
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

let toastTimer;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------
function wire() {
  // tabs
  document.getElementById("tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-screen]"); if (b) setScreen(b.dataset.screen);
  });

  // ricerca asta
  const search = document.getElementById("search");
  const results = document.getElementById("searchResults");
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    if (q.length < 2) { results.innerHTML = ""; return; }
    const found = BOARD.players
      .filter((p) => p.nome.toLowerCase().includes(q) || p.squadra.toLowerCase().includes(q))
      .sort((a, b) => Number(a.taken) - Number(b.taken) || b.prezzoConsigliato - a.prezzoConsigliato)
      .slice(0, 12);
    results.innerHTML = found.map((p) => `
      <div class="result-row ${p.taken ? "taken" : ""}" data-pick="${p.id}">
        <span class="rp ${p.ruolo}">${p.ruolo}</span>
        <div class="grow"><div class="nome">${esc(p.nome)}</div><div class="meta">${esc(p.squadra)} · ${p.tier}</div></div>
        <span class="price">${p.taken ? "preso" : p.prezzoConsigliato}</span>
      </div>`).join("");
  });

  // click delega su tutta la pagina
  document.body.addEventListener("click", (e) => {
    const pick = e.target.closest("[data-pick]");
    if (pick) { selectPlayer(pick.dataset.pick); return; }
    const fav = e.target.closest("[data-fav]");
    if (fav) { e.stopPropagation(); toggleFav(fav.dataset.fav); return; }
    const step = e.target.closest("[data-step]");
    if (step) { const inp = document.getElementById("priceInput"); inp.value = Math.max(1, (Number(inp.value) || 1) + Number(step.dataset.step)); return; }
    const buy = e.target.closest("[data-buy]");
    if (buy) { recordPurchase(buy.dataset.buy === "me" ? MY_TEAM : document.getElementById("oppSelect").value); return; }
    const undo = e.target.closest("[data-undo]");
    if (undo) { undoPurchaseByPlayer(undo.dataset.undo); return; }
    const undoidx = e.target.closest("[data-undoidx]");
    if (undoidx) { undoPurchaseIdx(Number(undoidx.dataset.undoidx)); return; }
  });

  // filtri listone
  document.getElementById("searchL").addEventListener("input", (e) => { ui.searchL = e.target.value.trim(); renderListone(); });
  document.getElementById("roleFilters").addEventListener("click", (e) => {
    const c = e.target.closest("[data-role]"); if (!c) return;
    ui.role = c.dataset.role;
    document.querySelectorAll("#roleFilters [data-role]").forEach((x) => x.classList.toggle("on", x === c));
    renderListone();
  });
  document.getElementById("sortBy").addEventListener("change", (e) => { ui.sort = e.target.value; renderListone(); });
  document.getElementById("onlyFav").addEventListener("click", (e) => { ui.onlyFav = !ui.onlyFav; e.target.classList.toggle("on", ui.onlyFav); renderListone(); });
  document.getElementById("hideTaken").addEventListener("click", (e) => { ui.hideTaken = !ui.hideTaken; e.target.classList.toggle("on", ui.hideTaken); renderListone(); });

  // impostazioni
  document.getElementById("refreshData").addEventListener("click", async (e) => {
    e.target.textContent = "⏳ Aggiorno…";
    try { await loadData(true); recompute(); toast("Dati aggiornati"); }
    catch { toast("Aggiornamento fallito"); }
    e.target.textContent = "🔄 Aggiorna dati"; renderAll();
  });
  document.getElementById("splitSettings").addEventListener("input", (e) => {
    const r = e.target.dataset.split; if (!r) return;
    CONFIG.splitPct[r] = Number(e.target.value);
    document.getElementById("splitVal" + r).textContent = CONFIG.splitPct[r] + "%";
    updateSplitSum(); persist(); recompute();
  });
  document.getElementById("myName").addEventListener("change", (e) => { CONFIG.myName = e.target.value || "IO"; persist(); renderAll(); });
  document.getElementById("oppSettings").addEventListener("change", (e) => {
    const i = e.target.dataset.opp; if (i == null) return;
    CONFIG.opponents[Number(i)] = e.target.value || `Avv ${Number(i) + 1}`; persist(); recompute();
  });
  document.getElementById("resetBtn").addEventListener("click", () => {
    if (confirm("Azzerare tutti gli acquisti dell'asta? (impostazioni e obiettivi restano)")) {
      PURCHASES = []; selectedId = null; persist(); recompute(); toast("Asta azzerata"); setScreen("asta");
    }
  });
  document.getElementById("exportBtn").addEventListener("click", exportBackup);
  document.getElementById("importBtn").addEventListener("click", () => document.getElementById("importFile").click());
  document.getElementById("importFile").addEventListener("change", importBackup);
}

function toggleFav(id) {
  if (FAVORITES.has(id)) FAVORITES.delete(id); else FAVORITES.add(id);
  persist();
  if (ui.screen === "listone") renderListone();
}

function exportBackup() {
  const data = JSON.stringify({ config: CONFIG, purchases: PURCHASES, favorites: [...FAVORITES] }, null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `fantaasta-backup.json`;
  a.click(); URL.revokeObjectURL(a.href);
  toast("Backup esportato");
}
function importBackup(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const d = JSON.parse(reader.result);
      if (d.config) CONFIG = { ...defaultConfig(), ...d.config };
      if (d.purchases) PURCHASES = d.purchases;
      if (d.favorites) FAVORITES = new Set(d.favorites);
      persist(); recompute(); renderAll(); toast("Backup importato");
    } catch { toast("File non valido"); }
  };
  reader.readAsText(file);
  e.target.value = "";
}

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------
async function init() {
  wire();
  try { await loadData(false); }
  catch { document.getElementById("calledCard").textContent = "Impossibile caricare i dati."; return; }
  recompute();
  renderAll();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}
init();
