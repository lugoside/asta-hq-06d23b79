// app.js — logica dell'interfaccia. Collega dati (players.json) + engine.js + DOM.
import { DEFAULT_CONFIG, ROLES, MY_TEAM, computeBoard, leagueTotals } from "./engine.js";

// ---------------------------------------------------------------------------
// Stato + persistenza
// ---------------------------------------------------------------------------
const LS = {
  config: "fa_config", purchases: "fa_purchases", fav: "fa_favorites",
  players: "fa_players_cache", meta: "fa_meta_cache", history: "fa_history",
  sync: "fa_sync", syncSeen: "fa_sync_seen", device: "fa_device",
};
const HISTORY_MAX = 40; // quanti backup automatici conservare
const RUOLO_NOME = { P: "Portiere", D: "Difensore", C: "Centrocampista", A: "Attaccante" };
const FORM_LABEL = { titolare: "🟢 Titolare", ballottaggio: "🟡 Ballottaggio", riserva: "⚪ Riserva" };
const FORM_SHORT = { titolare: "🟢", ballottaggio: "🟡", riserva: "⚪" };

const defaultConfig = () => ({
  numTeams: 10,
  budgetPerTeam: 500,
  roster: { ...DEFAULT_CONFIG.roster },
  splitPct: { P: 8, D: 14, C: 28, A: 50 },
  concentration: DEFAULT_CONFIG.concentration,
  strappo: DEFAULT_CONFIG.strappo,
  myName: "IO",
  opponents: Array.from({ length: 9 }, (_, i) => `Avv ${i + 1}`),
  adjust: {}, // aggiustamento manuale del valore per giocatore: { playerId: percentuale }
  notes: {},  // note manuali per giocatore: { playerId: "testo" }
});

let CONFIG = load(LS.config, defaultConfig());
let PURCHASES = load(LS.purchases, []);
let FAVORITES = new Set(load(LS.fav, []));
let PLAYERS = [];
let META = {};
let BOARD = null;
let selectedId = null;
// flusso di acquisto nella scheda Asta: idle → chooseOpp → confirm
let buyFlow = { mode: "idle", team: null, price: null };
let justDragged = false; // per non far scattare un tap subito dopo un drag&drop
const ui = { screen: "asta", role: "ALL", sort: "consigliato", onlyFav: false, hideTaken: false, searchL: "", expandedTeams: new Set() };

// --- stato sincronizzazione cloud (Firebase RTDB via REST) ---
// Default per questa lega (Valerio): URL + Codice preimpostati, sync attiva.
// Vengono usati solo se non c'è già una configurazione salvata sul dispositivo.
let SYNC = load(LS.sync, {
  url: "https://fantaasta-62ee7-default-rtdb.europe-west1.firebasedatabase.app/",
  code: "lugoasta",
  on: true,
});
let syncSeenTs = load(LS.syncSeen, 0);  // ultimo timestamp (del server) osservato
let pendingPush = false;                // ho modifiche locali non ancora confermate dal cloud
let DEVICE_ID = load(LS.device, "");
if (!DEVICE_ID) { DEVICE_ID = "dev-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); save(LS.device, DEVICE_ID); }
let _es = null, _pushTimer = null, _pollId = null, _syncStatus = "off";

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }
function persist() {
  save(LS.config, CONFIG); save(LS.purchases, PURCHASES); save(LS.fav, [...FAVORITES]);
  scheduleSnapshot();
  pendingPush = true;
  schedulePush();
}

// --- backup automatico: anello di snapshot con data/ora ---
let snapTimer;
function scheduleSnapshot() { clearTimeout(snapTimer); snapTimer = setTimeout(snapshotNow, 700); }
function snapshotNow() {
  try {
    clearTimeout(snapTimer);
    const hist = load(LS.history, []);
    const snap = { ts: Date.now(), purchases: PURCHASES, config: CONFIG, favorites: [...FAVORITES] };
    const last = hist[hist.length - 1];
    // niente doppioni: salta se identico all'ultimo snapshot
    if (last && JSON.stringify([last.purchases, last.config, last.favorites]) ===
                JSON.stringify([snap.purchases, snap.config, snap.favorites])) return;
    hist.push(snap);
    while (hist.length > HISTORY_MAX) hist.shift();
    save(LS.history, hist);
  } catch {}
}

// ===================== Sincronizzazione cloud (Firebase RTDB REST) =====================
// Offline-first: la memoria locale resta la base; il cloud allinea i dispositivi.
// Nodo condiviso: <url>/leghe/<codice>.json  — chi ha il codice legge/scrive (regole Firebase).
function persistSync() { save(LS.sync, SYNC); }
function syncNodeUrl() {
  if (!SYNC.url || !SYNC.code) return null;
  return SYNC.url.replace(/\/+$/, "") + "/leghe/" + encodeURIComponent(SYNC.code.trim()) + ".json";
}
function setSyncStatus(s) { _syncStatus = s; if (ui.screen === "impostazioni") renderSync(); }
function haveLocal() {
  if (PURCHASES.length || FAVORITES.size) return true;
  const d = defaultConfig();
  return JSON.stringify([CONFIG.myName, CONFIG.opponents, CONFIG.splitPct, CONFIG.roster, CONFIG.numTeams, CONFIG.budgetPerTeam])
       !== JSON.stringify([d.myName, d.opponents, d.splitPct, d.roster, d.numTeams, d.budgetPerTeam]);
}

function schedulePush() { if (!SYNC.on) return; clearTimeout(_pushTimer); _pushTimer = setTimeout(pushStateNow, 800); }
async function pushStateNow() {
  const url = syncNodeUrl(); if (!SYNC.on || !url) return;
  const doc = {
    updatedAt: { ".sv": "timestamp" }, // il server Firebase mette la SUA ora (unica per tutti i dispositivi)
    deviceId: DEVICE_ID, config: CONFIG, purchases: PURCHASES, favorites: [...FAVORITES],
  };
  try {
    await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc) });
    setSyncStatus("ok"); // pendingPush si azzera quando torna l'eco col timestamp del server
  } catch { setSyncStatus("err"); }
}
function adoptRemote(doc) {
  PURCHASES = Array.isArray(doc.purchases) ? doc.purchases : [];
  CONFIG = doc.config ? { ...defaultConfig(), ...doc.config } : CONFIG;
  FAVORITES = new Set(doc.favorites || []);
  pendingPush = false;
  save(LS.config, CONFIG); save(LS.purchases, PURCHASES); save(LS.fav, [...FAVORITES]);
  snapshotNow();
  recompute(); renderAll();
  toast("Sincronizzato da un altro dispositivo");
}
// Gestisce un documento ricevuto dal cloud. Ritorna 'adopted' | 'echo' | 'ignored' | 'invalid'.
function handleRemote(doc) {
  if (!doc || typeof doc.updatedAt !== "number") return "invalid";
  if (doc.deviceId === DEVICE_ID) {            // eco di una MIA scrittura
    if (doc.updatedAt > syncSeenTs) { syncSeenTs = doc.updatedAt; save(LS.syncSeen, syncSeenTs); }
    pendingPush = false;
    return "echo";
  }
  if (doc.updatedAt > syncSeenTs) {            // modifica più recente di un ALTRO dispositivo
    syncSeenTs = doc.updatedAt; save(LS.syncSeen, syncSeenTs);
    adoptRemote(doc);
    return "adopted";
  }
  return "ignored";
}
async function pullOnce() {
  const url = syncNodeUrl(); if (!SYNC.on || !url) return;
  try {
    const r = await fetch(url, { cache: "no-store" }); const remote = await r.json();
    handleRemote(remote);
    if (pendingPush) pushStateNow();           // ritrasmetti modifiche locali non ancora confermate
    setSyncStatus("ok");
  } catch { setSyncStatus("err"); }
}
async function reconcileSync() {
  const url = syncNodeUrl(); if (!SYNC.on || !url) return;
  try {
    const r = await fetch(url, { cache: "no-store" }); const remote = await r.json();
    const res = handleRemote(remote);
    if (res === "invalid" && haveLocal()) pushStateNow();   // cloud vuoto → semina con lo stato locale
    else if (res === "echo" && pendingPush) pushStateNow();  // il cloud è "nostro" ma abbiamo modifiche in sospeso
    setSyncStatus("ok");
  } catch { setSyncStatus("err"); }
}
function connectSSE() {
  if (_es) { _es.close(); _es = null; }
  const url = syncNodeUrl(); if (!SYNC.on || !url || typeof EventSource === "undefined") return;
  try {
    _es = new EventSource(url);
    const handler = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg && msg.path === "/") handleRemote(msg.data);
      } catch {}
    };
    _es.addEventListener("put", handler);
    _es.addEventListener("patch", handler);
    _es.onopen = () => setSyncStatus("ok");
    _es.onerror = () => setSyncStatus("err");
  } catch { setSyncStatus("err"); }
}
function startSync() {
  if (!SYNC.on) return;
  reconcileSync().then(connectSSE);
  if (!_pollId) _pollId = setInterval(pullOnce, 15000); // rete di sicurezza se l'SSE cade
}
function stopSync() {
  if (_es) { _es.close(); _es = null; }
  if (_pollId) { clearInterval(_pollId); _pollId = null; }
  setSyncStatus("off");
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

// cambia il numero di squadre (8..12): ridimensiona gli avversari e ricalcola tutto
function setNumTeams(n) {
  n = Math.max(8, Math.min(12, Math.round(n) || 10));
  CONFIG.numTeams = n;
  const need = n - 1;
  const cur = CONFIG.opponents.slice(0, need);
  while (cur.length < need) cur.push(`Avv ${cur.length + 1}`);
  CONFIG.opponents = cur;
  persist(); recompute(); renderAll();
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
// applica gli aggiustamenti manuali (±%) al valore base prima del calcolo prezzi
function adjustedPlayers() {
  const adj = CONFIG.adjust || {};
  if (!Object.keys(adj).length) return PLAYERS;
  return PLAYERS.map((p) => adj[p.id] ? { ...p, valoreBase: Math.max(0, p.valoreBase * (1 + adj[p.id] / 100)) } : p);
}
function recompute() {
  BOARD = computeBoard(adjustedPlayers(), PURCHASES, effectiveConfig());
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
    const offer = buyFlow.price != null ? buyFlow.price : Math.max(1, p.prezzoConsigliato);
    let semClass, semTxt;
    if (p.taken) { semClass = "giallo"; semTxt = `✔ Preso da ${teamName(p.takenBy)} a ${p.takenPrice}`; }
    else { const v = offerVerdict(p, offer); semClass = v.cls; semTxt = v.txt; }
    const adjPct = (CONFIG.adjust && CONFIG.adjust[p.id]) || 0;
    const pnote = (CONFIG.notes && CONFIG.notes[p.id]) || "";
    card.innerHTML = `
      <div class="top">
        <span class="rp ${p.ruolo}">${p.ruolo}</span>
        <div class="grow">
          <div class="nome">${esc(p.nome)}</div>
          <div class="sub">${esc(p.squadra)} · ${RUOLO_NOME[p.ruolo]} · valore ${p.valoreBase}</div>
        </div>
        <span class="tier ${p.tier}">${p.tier}</span>
      </div>
      ${p.infortunato ? `<div class="injury">🩹 <b>Infortunato</b> — rientro previsto ${esc(p.rientro || "?")}${p.motivoInfortunio ? `<br><span class="im">${esc(p.motivoInfortunio)}</span>` : ""}</div>` : ""}
      <div class="price-grid">
        <div class="box"><div class="v big">${p.prezzoConsigliato}</div><div class="l">consigliato</div></div>
        <div class="box"><div class="v">${p.prezzoMax}</div><div class="l">max strappo</div></div>
        <div class="box"><div class="v">${BOARD.me.maxBid}</div><div class="l">tuo max</div></div>
      </div>
      <div class="srcinfo">📊 Rating ${p.overall ?? "—"} · Bonus attesi ${p.bonusAtteso ?? "—"} · Titolarità ${Math.round((p.titolarita || 0) * 100)}%${p.formazione ? ` · ${FORM_LABEL[p.formazione]}` : ""}${p.rigoreRank ? ` · ⚽ Rigorista${p.rigoreRank > 1 ? " (" + p.rigoreRank + "ª)" : ""}` : ""}${p.punizioneRank ? ` · 🎯 Punizioni${p.punizioneRank > 1 ? " (" + p.punizioneRank + "ª)" : ""}` : ""}${p.cornerRank ? ` · 🚩 Corner${p.cornerRank > 1 ? " (" + p.cornerRank + "ª)" : ""}` : ""}${adjPct ? ` · <span class="adjv">aggiust. ${adjPct > 0 ? "+" : ""}${adjPct}%</span>` : ""}${pnote ? `<br>📝 ${esc(pnote)}` : ""}</div>
      <div class="semaforo ${semClass}" id="offerSem"><span class="dot"></span>${semTxt}</div>
      ${p.taken ? `<button class="btn ghost full" data-undo="${p.id}">↩ Annulla acquisto</button>` : `
      <div class="buy-row">
        <button class="step" data-step="-1">−</button>
        <input id="priceInput" type="number" inputmode="numeric" min="1" value="${buyFlow.price != null ? buyFlow.price : Math.max(1, p.prezzoConsigliato)}" />
        <button class="step" data-step="1">+</button>
      </div>
      ${buyActionsHtml(p)}`}
      <div class="adjust">
        <label>🎚️ Aggiusta valore <b>${adjPct > 0 ? "+" : ""}${adjPct}%</b> <span class="hint2">(titolarità, infortuni, mercato…)</span></label>
        <input type="range" min="-40" max="40" step="5" value="${adjPct}" data-adjust="${p.id}" />
        <input type="text" class="notein" placeholder="nota (es. rientra dall'infortunio, titolare sicuro…)" data-note="${p.id}" value="${esc(pnote)}" />
      </div>
    `;
  }
  renderRecent();
}

// Verdetto (semaforo) basato sull'OFFERTA che stai considerando, non solo sul consigliato.
function offerVerdict(p, offer) {
  const tuoMax = BOARD.me ? BOARD.me.maxBid : Infinity;
  if (!p.needRole) return { cls: "rosso", txt: "🔴 Ruolo già completo per te" };
  if (offer > tuoMax) return { cls: "rosso", txt: `🔴 Non puoi: oltre il tuo max (${tuoMax})` };
  if (offer > p.prezzoMax) return { cls: "rosso", txt: `🔴 Troppo caro (consigliato ${p.prezzoConsigliato})` };
  if (offer > p.prezzoConsigliato) return { cls: "giallo", txt: `🟡 Strappo ok (consigliato ${p.prezzoConsigliato})` };
  return { cls: "verde", txt: `🟢 Buon prezzo (≤ ${p.prezzoConsigliato})` };
}
// aggiorna il semaforo dal vivo mentre modifichi l'offerta, senza ridisegnare tutta la card
function updateOfferSem() {
  const el = document.getElementById("offerSem"); if (!el) return;
  const p = selectedId ? boardPlayer(selectedId) : null; if (!p || p.taken) return;
  const inp = document.getElementById("priceInput");
  const offer = Math.max(1, Math.round(Number(inp?.value) || p.prezzoConsigliato));
  const v = offerVerdict(p, offer);
  el.className = `semaforo ${v.cls}`;
  el.innerHTML = `<span class="dot"></span>${v.txt}`;
}

// Area azioni di acquisto: cambia in base allo stato del flusso (idle/chooseOpp/confirm)
function buyActionsHtml(p) {
  if (buyFlow.mode === "chooseOpp") {
    return `<div class="flow-title">A quale squadra è andato?</div>
      <div class="opp-grid">${CONFIG.opponents.map((o) => `<button class="btn opp" data-oppteam="${esc(o)}">${esc(o)}</button>`).join("")}</div>
      <button class="btn ghost full" data-flow="idle" style="margin-top:8px">← indietro</button>`;
  }
  if (buyFlow.mode === "confirm") {
    const price = buyFlow.price != null ? buyFlow.price : Math.max(1, p.prezzoConsigliato);
    return `<div class="confirm-box">Assegni <b>${esc(p.nome)}</b><br>a <b>${esc(buyFlow.team)}</b> per <b>${price}</b> crediti?</div>
      <div class="buy-actions">
        <button class="btn me" data-confirm="1">✓ OK, conferma</button>
        <button class="btn ghost" data-flow="chooseOpp">← cambia</button>
      </div>`;
  }
  return `<div class="buy-actions">
      <button class="btn me" data-buy="me">✓ Preso da ${esc(CONFIG.myName || "IO")}</button>
      <button class="btn opp" data-flow="chooseOpp">Preso da avversario →</button>
    </div>`;
}
function captureBuyPrice() {
  const inp = document.getElementById("priceInput");
  if (inp) buyFlow.price = Math.max(1, Math.round(Number(inp.value) || 1));
}

function renderRecent() {
  const el = document.getElementById("recentList");
  if (!PURCHASES.length) { el.innerHTML = `<div class="row"><span class="meta">Nessun acquisto ancora.</span></div>`; return; }
  el.innerHTML = PURCHASES.slice(-8).reverse().map((pu) => {
    const pl = PLAYERS.find((x) => x.id === pu.playerId) ||
               { ruolo: pu.ruolo || "?", nome: pu.nome || pu.playerId };
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
      <div class="grow"><div class="nome">${p.infortunato ? "🩹 " : ""}${esc(p.nome)}</div>
        <div class="meta">${esc(p.squadra)} · ${p.tier} · Qi ${p.qi} · val ${Math.round(p.valoreBase)}${p.formazione ? " · " + FORM_SHORT[p.formazione] : ""}${p.rigoreRank === 1 ? " · ⚽" : ""}${p.infortunato ? " · 🩹 rientro " + esc(p.rientro || "?") : ""}${p.taken ? " · preso " + teamName(p.takenBy) : ""}</div></div>
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
    const open = ui.expandedTeams.has(t.id);
    // giocatori acquistati da questa squadra (con fallback ai dati salvati nell'acquisto)
    const roster = PURCHASES.filter((pu) => pu.team === t.id).map((pu) => {
      const pl = PLAYERS.find((x) => x.id === pu.playerId) || { ruolo: pu.ruolo || "?", nome: pu.nome || pu.playerId };
      return { id: pu.playerId, ruolo: pl.ruolo, nome: pl.nome, price: pu.price };
    }).sort((a, b) => ROLES.indexOf(a.ruolo) - ROLES.indexOf(b.ruolo) || b.price - a.price);
    const rosterHtml = open ? `<div class="roster">${
      roster.length
        ? roster.map((p) => `<div class="rrow">
            <span class="grip" data-drag="${esc(p.id)}" data-from="${esc(t.id)}" title="Trascina per spostare">⠿</span>
            <span class="rp ${p.ruolo}">${p.ruolo}</span>
            <span class="rn">${esc(p.nome)}</span>
            <span class="rprice">${p.price}</span>
            <button class="rx" data-remove-purchase="${esc(p.id)}" title="Rimuovi">✕</button>
          </div>`).join("")
        : `<div class="rempty">Nessun giocatore ancora.</div>`
    }</div>` : "";
    return `<div class="team" data-drop-team="${esc(t.id)}">
      <div class="hd tap" data-team="${esc(t.id)}">
        <span class="nm ${t.isMe ? "me" : ""}">${open ? "▾" : "▸"} ${esc(t.name)}</span>
        <span class="bud">${s.budgetLeft} <small>/ ${CONFIG.budgetPerTeam} · ${s.count} giocatori</small></span>
      </div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="slotline">${ROLES.map((r) => `<span class="slot ${r}">${r} ${s.slotsRemaining[r]}</span>`).join("")}</div>
      ${rosterHtml}
    </div>`;
  }).join("");
}

// ---- IMPOSTAZIONI ----
function renderImpostazioni() {
  document.getElementById("metaInfo").innerHTML =
    `Stagione <b>${META.stagione || "?"}</b> · ${META.numGiocatori || PLAYERS.length} giocatori · ` +
    (META.isDemo ? "<b style='color:var(--giallo)'>dati DEMO</b>" : "listone reale") +
    (META.fonteAggiornata ? `<br>📅 Listone aggiornato dalla fonte: <b>${esc(META.fonteAggiornata)}</b>` : "") +
    (META.numInfortunati != null ? `<br>🩹 Infortunati segnalati: <b>${META.numInfortunati}</b>` : "") +
    (META.numFormazioni != null ? `<br>📋 Formazioni (titolari/ballottaggi/riserve): <b>${META.numFormazioni}</b>` : "") +
    (META.numRigoristi != null ? `<br>⚽ Rigoristi: <b>${META.numRigoristi}</b>${META.numPunizioni != null ? ` · 🎯 Punizioni: <b>${META.numPunizioni}</b>` : ""}${META.numCorner != null ? ` · 🚩 Corner: <b>${META.numCorner}</b>` : ""}` : "") +
    `<br>⬇ Ultimo scaricamento: ${fmtScarico()}` +
    `<br>Fonte: ${esc(META.fonte || "—")}`;

  const sp = document.getElementById("splitSettings");
  sp.innerHTML = ROLES.map((r) => `
    <div class="setting">
      <label>${RUOLO_NOME[r]} <span class="val" id="splitVal${r}">${CONFIG.splitPct[r]}%</span></label>
      <input type="range" min="0" max="70" value="${CONFIG.splitPct[r]}" data-split="${r}" />
    </div>`).join("");
  updateSplitSum();

  const nt = document.getElementById("numTeams");
  if (nt) { nt.value = CONFIG.numTeams; document.getElementById("numTeamsVal").textContent = CONFIG.numTeams; }
  const bt = document.getElementById("budgetPerTeam");
  if (bt && document.activeElement !== bt) bt.value = CONFIG.budgetPerTeam;
  document.getElementById("myName").value = CONFIG.myName;
  document.getElementById("oppSettings").innerHTML = CONFIG.opponents.map((o, i) => `
    <div class="setting" style="padding:6px 0"><input type="text" data-opp="${i}" value="${esc(o)}" /></div>`).join("");
  renderBackups();
  renderSync();
  renderSourcesInfo();
}

// freschezza delle fonti: da quanti giorni ogni pagina non cambia (⚠️ se ferma da un po')
function renderSourcesInfo() {
  const el = document.getElementById("sourcesInfo"); if (!el) return;
  const src = META.sources || {};
  const names = Object.keys(src);
  if (!names.length) { el.innerHTML = ""; return; }
  const STALE = 5, now = Date.now();
  const rows = names.map((name) => {
    const s = src[name];
    if (!s || !s.lastChanged) return `• ${name}: —`;
    const days = Math.floor((now - new Date(s.lastChanged).getTime()) / 86400000);
    const quando = days <= 0 ? "oggi" : days === 1 ? "ieri" : `${days} giorni fa`;
    return `${days >= STALE ? "⚠️" : "•"} ${name}: cambiata ${quando}`;
  });
  el.innerHTML = "<b>Freschezza fonti</b> <span style='opacity:.7'>(⚠️ = ferma da ≥5 giorni → valuta una nuova fonte)</span><br>" + rows.join("<br>");
}

function renderSync() {
  const u = document.getElementById("syncUrl"); if (!u) return;
  if (document.activeElement !== u) u.value = SYNC.url || "";
  const c = document.getElementById("syncCode");
  if (document.activeElement !== c) c.value = SYNC.code || "";
  document.getElementById("syncToggle").textContent = SYNC.on ? "⏸ Disattiva sincronizzazione" : "▶ Attiva sincronizzazione";
  const st = { ok: "🟢 connesso e allineato", err: "🔴 errore di connessione (controlla URL, Codice e regole Firebase)", off: "⚪ spenta" }[_syncStatus] || "";
  document.getElementById("syncStatus").innerHTML =
    (SYNC.on ? "Stato: " + st : "Spenta") +
    `<br>Inserisci lo <b>stesso URL e Codice Lega</b> su PC e telefono, poi attiva: i dati resteranno allineati da soli.`;
}

function renderBackups() {
  const el = document.getElementById("backupList");
  const hist = load(LS.history, []);
  if (!hist.length) { el.innerHTML = `<div class="row"><span class="meta">Nessun backup ancora.</span></div>`; return; }
  el.innerHTML = hist.map((s, idx) => {
    const d = new Date(s.ts);
    const when = d.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit" }) + " " +
      d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const n = (s.purchases || []).length;
    return { idx, html: `<div class="row">
      <div class="grow"><div class="nome">${when}</div><div class="meta">${n} acquist${n === 1 ? "o" : "i"}</div></div>
      <button class="btn ghost" data-restore="${idx}" style="padding:8px 12px">Ripristina</button>
    </div>` };
  }).reverse().map((r) => r.html).join("");
}

function restoreBackup(idx) {
  const hist = load(LS.history, []);
  const s = hist[idx];
  if (!s) return;
  const d = new Date(s.ts);
  const when = d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (!confirm(`Ripristinare il backup delle ${when} (${(s.purchases || []).length} acquisti)?\nLo stato attuale verrà prima salvato tra i backup.`)) return;
  snapshotNow(); // salva lo stato corrente prima di sovrascrivere
  PURCHASES = Array.isArray(s.purchases) ? s.purchases.slice() : [];
  if (s.config) CONFIG = { ...defaultConfig(), ...s.config };
  if (s.favorites) FAVORITES = new Set(s.favorites);
  save(LS.config, CONFIG); save(LS.purchases, PURCHASES); save(LS.fav, [...FAVORITES]);
  snapshotNow();
  recompute(); renderAll(); toast("Backup ripristinato");
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
  buyFlow = { mode: "idle", team: null, price: null };
  setScreen("asta");
  const s = document.getElementById("search"); if (s) s.value = "";
  document.getElementById("searchResults").innerHTML = "";
  renderAll();
}

function recordPurchase(team) {
  const p = boardPlayer(selectedId); if (!p) return;
  const input = document.getElementById("priceInput");
  const price = Math.max(1, Math.round(Number(input?.value) || p.prezzoConsigliato));
  // salvo anche nome/ruolo/squadra: l'acquisto resta valido anche se il listone cambia
  PURCHASES.push({ playerId: selectedId, price, team, nome: p.nome, ruolo: p.ruolo, squadra: p.squadra });
  persist(); snapshotNow(); recompute();
  toast(`${p.nome} → ${teamName(team)} a ${price}`);
  selectedId = null;
  buyFlow = { mode: "idle", team: null, price: null };
  renderAll();
}
function undoPurchaseIdx(idx) {
  if (idx >= 0 && idx < PURCHASES.length) {
    const pu = PURCHASES[idx]; const pl = PLAYERS.find((x) => x.id === pu.playerId);
    PURCHASES.splice(idx, 1); persist(); snapshotNow(); recompute();
    toast(`Annullato: ${pl ? pl.nome : (pu.nome || "acquisto")}`);
    renderAll();
  }
}
function undoPurchaseByPlayer(id) {
  const idx = PURCHASES.map((p) => p.playerId).lastIndexOf(id);
  undoPurchaseIdx(idx);
}
function movePurchase(pid, toTeam) {
  const pu = PURCHASES.find((p) => p.playerId === pid);
  if (!pu || pu.team === toTeam) return;
  pu.team = toTeam;
  persist(); snapshotNow(); recompute(); renderAll();
  const pl = PLAYERS.find((x) => x.id === pid);
  toast(`${pl ? pl.nome : "Giocatore"} → ${teamName(toTeam)}`);
}

// Drag & drop (Pointer Events: funziona con mouse e con dito) per spostare un
// giocatore tra squadre nella scheda Squadre. Si trascina dalla maniglia ⠿.
function teamCardAt(x, y) {
  const el = document.elementFromPoint(x, y);
  return el ? el.closest("[data-drop-team]") : null;
}
function setupTeamDnD() {
  const list = document.getElementById("teamsList");
  if (!list) return;
  let drag = null;
  const onMove = (e) => {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 8) return;
      drag.moved = true; drag.clone.style.display = "block";
    }
    e.preventDefault();
    drag.clone.style.left = e.clientX + "px";
    drag.clone.style.top = e.clientY + "px";
    const card = teamCardAt(e.clientX, e.clientY);
    if (drag.hover && drag.hover !== card) drag.hover.classList.remove("drop-hover");
    if (card && card.dataset.dropTeam !== drag.from) { card.classList.add("drop-hover"); drag.hover = card; }
    else drag.hover = null;
  };
  const onUp = (e) => {
    if (!drag) return;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    drag.clone.remove();
    if (drag.hover) drag.hover.classList.remove("drop-hover");
    if (drag.moved) {
      justDragged = true; setTimeout(() => { justDragged = false; }, 350);
      const card = teamCardAt(e.clientX, e.clientY);
      if (card && card.dataset.dropTeam && card.dataset.dropTeam !== drag.from) movePurchase(drag.pid, card.dataset.dropTeam);
    }
    drag = null;
  };
  list.addEventListener("pointerdown", (e) => {
    const grip = e.target.closest("[data-drag]");
    if (!grip) return;
    e.preventDefault();
    const clone = document.createElement("div");
    clone.className = "drag-clone";
    clone.textContent = grip.parentElement.querySelector(".rn")?.textContent || "•";
    clone.style.display = "none";
    document.body.appendChild(clone);
    drag = { pid: grip.dataset.drag, from: grip.dataset.from, sx: e.clientX, sy: e.clientY, moved: false, clone, hover: null };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
  });
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

  // aggiorna il semaforo mentre digiti l'offerta
  document.body.addEventListener("input", (e) => {
    if (e.target && e.target.id === "priceInput") {
      buyFlow.price = Math.max(1, Math.round(Number(e.target.value) || 1));
      updateOfferSem();
    }
  });

  // manopola manuale (aggiustamento ±% e nota) per giocatore
  document.body.addEventListener("change", (e) => {
    const t = e.target; if (!t || !t.dataset) return;
    if (t.dataset.adjust != null) {
      const pid = t.dataset.adjust, v = Number(t.value) || 0;
      CONFIG.adjust = CONFIG.adjust || {};
      if (v === 0) delete CONFIG.adjust[pid]; else CONFIG.adjust[pid] = v;
      persist(); recompute(); renderAll();
    } else if (t.dataset.note != null) {
      const pid = t.dataset.note, v = t.value.trim();
      CONFIG.notes = CONFIG.notes || {};
      if (!v) delete CONFIG.notes[pid]; else CONFIG.notes[pid] = v;
      persist();
    }
  });

  // click delega su tutta la pagina
  document.body.addEventListener("click", (e) => {
    if (justDragged) return; // ignora il click sintetico dopo un trascinamento
    const remP = e.target.closest("[data-remove-purchase]");
    if (remP) { undoPurchaseByPlayer(remP.dataset.removePurchase); return; }
    const pick = e.target.closest("[data-pick]");
    if (pick) { selectPlayer(pick.dataset.pick); return; }
    const fav = e.target.closest("[data-fav]");
    if (fav) { e.stopPropagation(); toggleFav(fav.dataset.fav); return; }
    const step = e.target.closest("[data-step]");
    if (step) { const inp = document.getElementById("priceInput"); const v = Math.max(1, (Number(inp.value) || 1) + Number(step.dataset.step)); inp.value = v; buyFlow.price = v; updateOfferSem(); return; }
    const buy = e.target.closest("[data-buy]");
    if (buy) { recordPurchase(MY_TEAM); return; }
    const flow = e.target.closest("[data-flow]");
    if (flow) { captureBuyPrice(); buyFlow.mode = flow.dataset.flow; if (flow.dataset.flow === "idle") buyFlow.team = null; renderAsta(); return; }
    const oppteam = e.target.closest("[data-oppteam]");
    if (oppteam) { captureBuyPrice(); buyFlow.team = oppteam.dataset.oppteam; buyFlow.mode = "confirm"; renderAsta(); return; }
    const confirmBuy = e.target.closest("[data-confirm]");
    if (confirmBuy) { recordPurchase(buyFlow.team); return; }
    const undo = e.target.closest("[data-undo]");
    if (undo) { undoPurchaseByPlayer(undo.dataset.undo); return; }
    const undoidx = e.target.closest("[data-undoidx]");
    if (undoidx) { undoPurchaseIdx(Number(undoidx.dataset.undoidx)); return; }
    const restore = e.target.closest("[data-restore]");
    if (restore) { restoreBackup(Number(restore.dataset.restore)); return; }
    const teamTog = e.target.closest("[data-team]");
    if (teamTog) {
      const id = teamTog.dataset.team;
      if (ui.expandedTeams.has(id)) ui.expandedTeams.delete(id); else ui.expandedTeams.add(id);
      renderSquadre(); return;
    }
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
  document.getElementById("numTeams").addEventListener("input", (e) => { document.getElementById("numTeamsVal").textContent = e.target.value; });
  document.getElementById("numTeams").addEventListener("change", (e) => setNumTeams(Number(e.target.value)));
  document.getElementById("budgetPerTeam").addEventListener("change", (e) => {
    const v = Math.round(Number(e.target.value));
    if (!v || v < 1) { e.target.value = CONFIG.budgetPerTeam; return; } // valore non valido → ripristina
    CONFIG.budgetPerTeam = v; persist(); recompute(); renderAll();
  });
  document.getElementById("myName").addEventListener("change", (e) => { CONFIG.myName = e.target.value || "IO"; persist(); renderAll(); });
  document.getElementById("oppSettings").addEventListener("change", (e) => {
    const i = e.target.dataset.opp; if (i == null) return;
    CONFIG.opponents[Number(i)] = e.target.value || `Avv ${Number(i) + 1}`; persist(); recompute();
  });
  document.getElementById("resetBtn").addEventListener("click", () => {
    if (confirm("Azzerare tutti gli acquisti dell'asta? Lo stato attuale resta tra i backup automatici (potrai ripristinarlo). Impostazioni e obiettivi restano.")) {
      snapshotNow();                 // salva lo stato pre-reset così è recuperabile
      PURCHASES = []; selectedId = null; persist(); snapshotNow(); recompute();
      toast("Asta azzerata (recuperabile dai backup)"); setScreen("asta");
    }
  });
  // --- sincronizzazione ---
  document.getElementById("syncUrl").addEventListener("change", (e) => { SYNC.url = e.target.value.trim(); persistSync(); if (SYNC.on) startSync(); });
  document.getElementById("syncCode").addEventListener("change", (e) => { SYNC.code = e.target.value.trim(); persistSync(); if (SYNC.on) startSync(); });
  document.getElementById("syncGen").addEventListener("click", () => {
    SYNC.code = "asta-" + Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 8);
    persistSync(); renderSync();
  });
  document.getElementById("syncToggle").addEventListener("click", () => {
    if (!SYNC.on && (!SYNC.url || !SYNC.code)) { toast("Inserisci URL e Codice Lega"); return; }
    SYNC.on = !SYNC.on; persistSync();
    if (SYNC.on) { startSync(); toast("Sincronizzazione attivata"); } else { stopSync(); toast("Sincronizzazione disattivata"); }
    renderSync();
  });
  document.getElementById("forceApp").addEventListener("click", forceAppUpdate);
  document.getElementById("exportBtn").addEventListener("click", exportBackup);
  document.getElementById("importBtn").addEventListener("click", () => document.getElementById("importFile").click());
  document.getElementById("importFile").addEventListener("change", importBackup);
  setupTeamDnD();
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
      persist(); snapshotNow(); recompute(); renderAll(); toast("Backup importato");
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
  // chiedi al browser di NON sfrattare i dati salvati (importante durante l'asta)
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch {}
  try { await loadData(false); }
  catch { document.getElementById("calledCard").textContent = "Impossibile caricare i dati."; return; }
  recompute();
  renderAll();
  if (SYNC.on) startSync();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
    // quando un nuovo service worker prende il controllo, ricarica una volta per avere l'ultima versione
    let _refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (_refreshing) return; _refreshing = true; location.reload();
    });
  }
}

// scialuppa: cancella cache + service worker e ricarica (per forzare l'ultima versione)
async function forceAppUpdate() {
  try {
    if ("serviceWorker" in navigator) {
      const rs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(rs.map((r) => r.unregister()));
    }
    if (window.caches) {
      const ks = await caches.keys();
      await Promise.all(ks.map((k) => caches.delete(k)));
    }
  } catch {}
  location.reload();
}
init();
