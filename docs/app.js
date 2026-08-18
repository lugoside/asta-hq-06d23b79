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
const ui = { screen: "asta", role: "ALL", sort: "consigliato", onlyFav: false, hideTaken: false, searchL: "", expandedTeams: new Set() };

// --- stato sincronizzazione cloud (Firebase RTDB via REST) ---
let SYNC = load(LS.sync, { url: "", code: "", on: false });
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
    const open = ui.expandedTeams.has(t.id);
    // giocatori acquistati da questa squadra (con fallback ai dati salvati nell'acquisto)
    const roster = PURCHASES.filter((pu) => pu.team === t.id).map((pu) => {
      const pl = PLAYERS.find((x) => x.id === pu.playerId) || { ruolo: pu.ruolo || "?", nome: pu.nome || pu.playerId };
      return { ruolo: pl.ruolo, nome: pl.nome, price: pu.price };
    }).sort((a, b) => ROLES.indexOf(a.ruolo) - ROLES.indexOf(b.ruolo) || b.price - a.price);
    const rosterHtml = open ? `<div class="roster">${
      roster.length
        ? roster.map((p) => `<div class="rrow"><span class="rp ${p.ruolo}">${p.ruolo}</span><span class="rn">${esc(p.nome)}</span><span class="rprice">${p.price}</span></div>`).join("")
        : `<div class="rempty">Nessun giocatore ancora.</div>`
    }</div>` : "";
    return `<div class="team">
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
  renderBackups();
  renderSync();
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
  }
}
init();
