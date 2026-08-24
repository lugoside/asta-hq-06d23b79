// app.js — logica dell'interfaccia. Collega dati (players.json) + engine.js + DOM.
import { DEFAULT_CONFIG, ROLES, MY_TEAM, computeBoard, leagueTotals, reduceMoves } from "./engine.js";

// ---------------------------------------------------------------------------
// Stato + persistenza
// ---------------------------------------------------------------------------
const LS = {
  config: "fa_config", purchases: "fa_purchases", fav: "fa_favorites",
  players: "fa_players_cache", meta: "fa_meta_cache", history: "fa_history", giornata: "fa_giornata_cache",
  sync: "fa_sync", syncSeen: "fa_sync_seen", device: "fa_device",
  moves: "fa_moves", // log di mosse append-only (nuovo modello di sync condiviso)
  resetSeen: "fa_reset_seen", // ultimo resetAt applicato (per il reset di lega)
  unlocked: "fa_unlocked", // gate master password superato su questo dispositivo
  discreet: "fa_discreet", // modalità discreta (aspetto LITE, consigli nascosti a colpo d'occhio)
  showtabs: "fa_showtabs", // schede avanzate Analisi/Formazione visibili
};
// Gate master (deterrente contro chi indovina l'URL della FULL). SOFT: il repo è pubblico,
// i dati grezzi restano tecnicamente accessibili a un esperto; la password ferma lo sbirbo casuale.
const MASTER_PW_HASH = "9d469067065248e17baf9330ab4a350c1b5785780f247996377112154992e566";
async function checkMasterPw(pw) {
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pw || ""));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("") === MASTER_PW_HASH;
  } catch { return false; }
}
let unlocked = load(LS.unlocked, false);
const APP_VERSION = "v60"; // mostrata in Setup per capire se l'app è aggiornata (allineata a sw.js)
const HISTORY_MAX = 40; // quanti backup automatici conservare
const RUOLO_NOME = { P: "Portiere", D: "Difensore", C: "Centrocampista", A: "Attaccante" };
const FORM_LABEL = { titolare: "🟢 Titolare", ballottaggio: "🟡 Ballottaggio", riserva: "⚪ Riserva" };
const FORM_SHORT = { titolare: "🟢", ballottaggio: "🟡", riserva: "⚪" };
// fascia goal.com (guida asta a fasce): 1=top .. 4=scommesse. Il valore è già corretto
// in pipeline (goalFactor); qui è solo trasparenza sul perché di un prezzo.
const GOAL_BAND_LABEL = { 1: "1ª fascia", 2: "2ª fascia", 3: "3ª fascia", 4: "scommessa" };

const defaultConfig = () => ({
  numTeams: 10,
  budgetPerTeam: 500,
  roster: { ...DEFAULT_CONFIG.roster },
  splitPct: { P: 8, D: 14, C: 28, A: 50 },
  concentration: DEFAULT_CONFIG.concentration,
  strappo: DEFAULT_CONFIG.strappo,
  // teams = elenco COMPLETO dei nomi squadra (config di LEGA, condivisa/admin).
  // myTeam = quale squadra sono IO (scelta LOCALE, non condivisa).
  teams: ["IO", ...Array.from({ length: 9 }, (_, i) => `Avv ${i + 1}`)],
  myTeam: "IO",
  auctionOpen: true, // asta aperta/chiusa (config di LEGA): quando chiusa, nessuno modifica le rose
  resetAt: 0,        // marcatore reset di lega: quando cresce, ogni dispositivo azzera le mosse locali
  adjust: {}, // aggiustamento manuale del valore per giocatore: { playerId: percentuale }
  notes: {},  // note manuali per giocatore: { playerId: "testo" }
});

// Normalizza la config: migra il vecchio modello (myName+opponents) al nuovo
// (teams[]+myTeam), mantiene numTeams coerente con teams.length e myTeam valido.
function normalizeConfig(c) {
  c = c || {};
  if (!Array.isArray(c.teams)) {                       // migrazione dal vecchio schema
    const me = c.myName || "IO";
    const opp = Array.isArray(c.opponents) ? c.opponents : [];
    c.teams = [me, ...opp];
    if (!c.myTeam) c.myTeam = me;
  }
  const n = Math.max(2, Math.round(c.numTeams || c.teams.length || 10));
  if (c.teams.length !== n) {                           // allinea la lista al numero squadre
    c.teams = c.teams.slice(0, n);
    while (c.teams.length < n) c.teams.push(`Avv ${c.teams.length}`);
  }
  c.numTeams = c.teams.length;
  if (!c.myTeam || !c.teams.includes(c.myTeam)) c.myTeam = c.teams[0]; // "io" deve esistere
  if (typeof c.auctionOpen !== "boolean") c.auctionOpen = true;        // default: asta aperta
  if (typeof c.resetAt !== "number") c.resetAt = 0;
  delete c.myName; delete c.opponents;                 // via i campi obsoleti
  return c;
}

let CONFIG = normalizeConfig(load(LS.config, defaultConfig()));
let MOVES = load(LS.moves, []);            // log append-only (fonte di verità degli acquisti)
let resetSeen = load(LS.resetSeen, 0);     // ultimo resetAt applicato localmente
let PURCHASES = [];                         // derivato: reduceMoves(MOVES) con team ricondotti al locale
let FAVORITES = new Set(load(LS.fav, []));  // preferiti: SOLO locali (personali, non condivisi)
let PLAYERS = [];
let META = {};
let GIORNATA = load(LS.giornata, null);   // dati di giornata (statistiche + probabili + fixtures), da fetch_giornata.py
let formDemo = null;                       // dataset DEMO (rosa+stat casuali) per provare la Formazione senza toccare la lega vera
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
let DEVICE_ID = load(LS.device, "");
if (!DEVICE_ID) { DEVICE_ID = "dev-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); save(LS.device, DEVICE_ID); }
let _esMoves = null, _esConfig = null, _pollId = null, _syncStatus = "off", _configTimer = null, _seeded = false;
const _inflight = new Set(); // uid delle mosse in invio (in MEMORIA, non persistito): dedup senza perdere ritenti

// Config di LEGA condivisa via cloud (/config): regole valide per tutti + elenco squadre.
// Personali (NON condivisi, restano locali): splitPct, concentration, strappo, adjust, notes.
const SHARED_CONFIG_KEYS = ["numTeams", "budgetPerTeam", "roster", "teams", "auctionOpen", "resetAt"];

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }

// --- camuffamento: modalità discreta (aspetto LITE) + schede avanzate ----------
let DISCREET = load(LS.discreet, true);   // default: discreta (sicura sotto asta)
let SHOWTABS = load(LS.showtabs, false);  // default: Analisi/Formazione nascoste
function applyDisguise() {
  document.body.classList.toggle("discreet", DISCREET);
  document.body.classList.toggle("showtabs", SHOWTABS);
  const dot = document.getElementById("disguiseToggle");
  if (dot) { dot.classList.toggle("ext", !DISCREET); dot.textContent = DISCREET ? "" : "●"; }
  const db = document.getElementById("discreetToggle");
  if (db) { db.textContent = DISCREET ? "🕶️ Modalità discreta: ATTIVA" : "👁️ Modalità discreta: spenta (vista piena)"; db.classList.toggle("me", !DISCREET); }
  const tb = document.getElementById("showTabsToggle");
  if (tb) tb.textContent = SHOWTABS ? "📊 Schede Analisi/Formazione: visibili" : "📊 Schede Analisi/Formazione: nascoste";
}
function setDiscreet(v) { DISCREET = v; save(LS.discreet, DISCREET); applyDisguise(); renderAll(); }
function setShowTabs(v) {
  SHOWTABS = v; save(LS.showtabs, SHOWTABS); applyDisguise();
  if (!SHOWTABS && (ui.screen === "analisi" || ui.screen === "formazione")) setScreen("asta");
}
// persist(): una modifica di CONFIGURAZIONE/impostazioni (non un acquisto).
// Salva localmente e programma la pubblicazione della config condivisa sul cloud.
function persist() {
  save(LS.config, CONFIG); save(LS.fav, [...FAVORITES]);
  scheduleSnapshot();
  scheduleConfigPush();
}
function saveMoves() { save(LS.moves, MOVES); }
// reset di lega: se resetAt (config condivisa) è cresciuto, azzera le mosse LOCALI.
// Il cloud /moves viene svuotato dall'admin; così ogni dispositivo riparte pulito.
function applyResetIfNeeded() {
  if ((CONFIG.resetAt || 0) > resetSeen) {
    MOVES = []; saveMoves();
    resetSeen = CONFIG.resetAt; save(LS.resetSeen, resetSeen);
  }
}
async function deleteCloudMoves() {
  const url = movesUrl(); if (!SYNC.on || !url) return;
  try { await fetch(url + ".json", { method: "DELETE" }); } catch {}
}
// ricostruisce PURCHASES dal log di mosse; i team condivisi tornano id locali (MY_TEAM per me)
function rebuildPurchases() {
  PURCHASES = reduceMoves(MOVES).map((p) => ({ ...p, team: sharedTeamToLocal(p.team) }));
  save(LS.purchases, PURCHASES); // cache di comodità (backup/export continuano a leggerla)
}
// porta lo stato acquisti verso `target` (lista in forma locale) emettendo mosse compensative.
// Usato da reset (target vuoto), ripristino backup e import: funziona anche sotto sync condivisa.
function applyPurchasesTarget(target) {
  target = Array.isArray(target) ? target : [];
  const curById = new Map(PURCHASES.map((p) => [p.playerId, p]));
  const tgtById = new Map(target.map((p) => [p.playerId, p]));
  for (const p of [...PURCHASES]) if (!tgtById.has(p.playerId)) emitMove({ type: "undo", playerId: p.playerId });
  for (const t of target) {
    const cur = curById.get(t.playerId);
    if (!cur) emitMove({ type: "buy", playerId: t.playerId, team: t.team, price: t.price, nome: t.nome, ruolo: t.ruolo, squadra: t.squadra });
    else if (cur.team !== t.team || cur.price !== t.price)
      emitMove({ type: "move", playerId: t.playerId, team: t.team, price: t.price, nome: t.nome, ruolo: t.ruolo, squadra: t.squadra });
  }
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
// Modello CONDIVISO multi-writer, offline-first. Due nodi sotto leghe/<codice>:
//   /config          → configurazione di lega (la scrive l'app piena; tutti leggono)
//   /moves/<pushId>  → log append-only di mosse (buy|undo|move); ognuno aggiunge le sue
// Lo stato dell'asta è reduceMoves(tutte le mosse): i click di più persone si FONDONO
// invece di sovrascriversi. I preferiti NON vanno sul cloud (sono personali).
function persistSync() { save(LS.sync, SYNC); }
function nodeBase() {
  if (!SYNC.url || !SYNC.code) return null;
  return SYNC.url.replace(/\/+$/, "") + "/leghe/" + encodeURIComponent(SYNC.code.trim());
}
function movesUrl()  { const b = nodeBase(); return b ? b + "/moves"  : null; }
function configUrl() { const b = nodeBase(); return b ? b + "/config" : null; }
function setSyncStatus(s) { _syncStatus = s; if (ui.screen === "impostazioni") renderSync(); }

function mkUid() {
  return (DEVICE_ID.replace(/^dev-/, "").slice(0, 6) || "x") + "-" +
         Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
}
// nome-squadra condiviso ⇄ id locale (MY_TEAM per la mia squadra; gli avversari sono già nomi)
function sharedTeamToLocal(name) { return name != null && name === CONFIG.myTeam ? MY_TEAM : name; }
function localTeamToShared(id)   { return id === MY_TEAM ? CONFIG.myTeam : id; }

function haveLocalConfig() {
  const d = defaultConfig();
  return JSON.stringify(SHARED_CONFIG_KEYS.map((k) => CONFIG[k]))
       !== JSON.stringify(SHARED_CONFIG_KEYS.map((k) => d[k]));
}

// --- MOSSE: emissione locale (ottimistica) + push sul cloud ---------------------------
// applica subito la mossa in locale e la spedisce; `team` passa alla forma condivisa.
function emitMove(mv) {
  const m = { uid: mkUid(), id: null, type: mv.type, playerId: mv.playerId, ts: Date.now(), byDevice: DEVICE_ID, posted: false };
  m.id = m.uid; // finché non arriva il pushId del server, l'id stabile per il reducer è l'uid
  if (mv.team != null)    m.team = localTeamToShared(mv.team);
  if (mv.price != null)   m.price = mv.price;
  if (mv.nome != null)    m.nome = mv.nome;
  if (mv.ruolo != null)   m.ruolo = mv.ruolo;
  if (mv.squadra != null) m.squadra = mv.squadra;
  MOVES.push(m);
  saveMoves(); rebuildPurchases(); scheduleSnapshot();
  pushMoveToCloud(m);
  return m;
}
async function pushMoveToCloud(m) {
  const url = movesUrl(); if (!SYNC.on || !url || m.posted || _inflight.has(m.uid)) return; // già inviata / in invio
  _inflight.add(m.uid);                                             // dedup concorrenza (in memoria)
  const body = { uid: m.uid, type: m.type, playerId: m.playerId, byDevice: m.byDevice, ts: { ".sv": "timestamp" } };
  for (const k of ["team", "price", "nome", "ruolo", "squadra"]) if (m[k] != null) body[k] = m[k];
  try {
    await fetch(url + ".json", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    m.posted = true; saveMoves(); setSyncStatus("ok");             // posted solo DOPO invio riuscito → fetch interrotta = ritentata
  } catch { setSyncStatus("err"); }
  finally { _inflight.delete(m.uid); }
}
async function flushPending() {
  if (!SYNC.on) return;
  for (const m of MOVES.filter((x) => x.posted === false && x.byDevice === DEVICE_ID)) await pushMoveToCloud(m);
}
// fonde le mosse ricevute dal cloud nel log locale (de-dup per uid; il ts del server prevale)
function mergeCloudMoves(obj) {
  if (!obj || typeof obj !== "object") return false;
  const byUid = new Map(MOVES.map((m) => [m.uid, m]));
  let changed = false;
  for (const [pushId, mv] of Object.entries(obj)) {
    if (!mv || !mv.uid) continue;
    const local = byUid.get(mv.uid);
    if (!local) {
      const inc = { ...mv, id: pushId, posted: true };
      MOVES.push(inc); byUid.set(mv.uid, inc); changed = true;
    } else if (typeof mv.ts === "number" && (local.ts !== mv.ts || local.id !== pushId || local.posted !== true)) {
      Object.assign(local, mv, { id: pushId, posted: true }); changed = true; // eco confermata dal server
    }
  }
  if (changed) { saveMoves(); rebuildPurchases(); }
  return changed;
}

// --- CONFIG condivisa: pubblicazione (app piena) e adozione ---------------------------
function scheduleConfigPush() { if (!SYNC.on) return; clearTimeout(_configTimer); _configTimer = setTimeout(pushConfig, 800); }
function sharedConfigPayload() { const o = {}; for (const k of SHARED_CONFIG_KEYS) o[k] = CONFIG[k]; return o; }
async function pushConfig() {
  const url = configUrl(); if (!SYNC.on || !url) return;
  try {
    await fetch(url + ".json", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sharedConfigPayload()) });
    setSyncStatus("ok");
  } catch { setSyncStatus("err"); }
}
function adoptConfig(remote) {
  if (!remote || typeof remote !== "object") return false;
  const prevReset = CONFIG.resetAt || 0;
  let changed = false;
  for (const k of SHARED_CONFIG_KEYS) {
    if (remote[k] !== undefined && JSON.stringify(remote[k]) !== JSON.stringify(CONFIG[k])) { CONFIG[k] = remote[k]; changed = true; }
  }
  // resetAt MONOTÒNO: non scende mai (un device con valore vecchio non può abbassarlo)
  const maxReset = Math.max(prevReset, remote.resetAt || 0);
  if ((CONFIG.resetAt || 0) !== maxReset) { CONFIG.resetAt = maxReset; changed = true; }
  if (changed) { normalizeConfig(CONFIG); save(LS.config, CONFIG); applyResetIfNeeded(); rebuildPurchases(); } // teams→myTeam valido; resetAt→purga mosse locali
  return changed;
}

// --- Avvio/allineamento ---------------------------------------------------------------
async function reconcileSync() {
  const cu = configUrl(), mu = movesUrl(); if (!SYNC.on || !cu || !mu) return;
  try {
    // 1) config: se il cloud ce l'ha, è la verità condivisa → adotta; se è vuota e ho una
    //    config non-default, la semino io (app piena = proprietaria della lega).
    const rc = await (await fetch(cu + ".json", { cache: "no-store" })).json();
    if (rc && typeof rc === "object") {
      if (adoptConfig(rc)) { recompute(); renderAll(); }
      // se il cloud ha una config di vecchio formato (senza teams[]), la aggiorno al nuovo
      // schema così la LITE legge l'elenco squadre senza interventi manuali.
      if ((!Array.isArray(rc.teams) || rc.auctionOpen === undefined) && Array.isArray(CONFIG.teams) && CONFIG.teams.length) await pushConfig();
    } else if (haveLocalConfig()) await pushConfig();

    // 2) mosse: se il log remoto è vuoto e non ho ancora mosse locali, migro dai vecchi acquisti.
    const rm = await (await fetch(mu + ".json", { cache: "no-store" })).json();
    const remoteEmpty = !rm || (typeof rm === "object" && !Object.keys(rm).length);
    if (remoteEmpty && !MOVES.length) await seedMovesFromLegacy();
    if (rm) mergeCloudMoves(rm);
    await flushPending();
    recompute(); renderAll(); setSyncStatus("ok");
  } catch { setSyncStatus("err"); }
}
// migrazione una-tantum: acquisti del vecchio modello → mosse `buy`.
// sorgente: acquisti locali; in mancanza, il vecchio nodo condiviso leghe/<code>/purchases.
async function seedMovesFromLegacy() {
  let legacy = load(LS.purchases, []);
  if (!Array.isArray(legacy) || !legacy.length) {
    try { const lp = await (await fetch(nodeBase() + "/purchases.json", { cache: "no-store" })).json(); if (Array.isArray(lp)) legacy = lp; } catch {}
  }
  if (!Array.isArray(legacy) || !legacy.length) return;
  for (const pu of legacy) emitMove({ type: "buy", playerId: pu.playerId, team: pu.team, price: pu.price, nome: pu.nome, ruolo: pu.ruolo, squadra: pu.squadra });
}
async function pullOnce() {
  const mu = movesUrl(), cu = configUrl(); if (!SYNC.on || !mu) return;
  try {
    const rm = await (await fetch(mu + ".json", { cache: "no-store" })).json();
    const cm = mergeCloudMoves(rm);
    let cc = false;
    if (cu) { const rc = await (await fetch(cu + ".json", { cache: "no-store" })).json(); cc = adoptConfig(rc); }
    if (cm || cc) { recompute(); renderAll(); }
    await flushPending();
    setSyncStatus("ok");
  } catch { setSyncStatus("err"); }
}
function connectSSE() {
  for (const es of [_esMoves, _esConfig]) if (es) es.close();
  _esMoves = _esConfig = null;
  const mu = movesUrl(), cu = configUrl();
  if (!SYNC.on || !mu || typeof EventSource === "undefined") return;
  try {
    _esMoves = new EventSource(mu + ".json");
    const onMoves = (ev) => {
      try {
        const msg = JSON.parse(ev.data); if (!msg) return;
        if (msg.path === "/") { if (mergeCloudMoves(msg.data)) { recompute(); renderAll(); } }
        else if (msg.path && msg.data && msg.data.uid) {
          const pushId = msg.path.replace(/^\//, "");
          if (mergeCloudMoves({ [pushId]: msg.data })) { recompute(); renderAll(); }
        }
      } catch {}
    };
    _esMoves.addEventListener("put", onMoves);
    _esMoves.addEventListener("patch", onMoves);
    _esMoves.onopen = () => setSyncStatus("ok");
    _esMoves.onerror = () => setSyncStatus("err");

    if (cu) {
      _esConfig = new EventSource(cu + ".json");
      const onConfig = (ev) => {
        try { const msg = JSON.parse(ev.data); if (msg && msg.path === "/" && adoptConfig(msg.data)) { recompute(); renderAll(); } } catch {}
      };
      _esConfig.addEventListener("put", onConfig);
      _esConfig.addEventListener("patch", onConfig);
    }
  } catch { setSyncStatus("err"); }
}
function startSync() {
  if (!SYNC.on) return;
  reconcileSync().then(connectSSE);
  if (!_pollId) _pollId = setInterval(pullOnce, 10000); // rete di sicurezza se l'SSE cade
}
function stopSync() {
  for (const es of [_esMoves, _esConfig]) if (es) es.close();
  _esMoves = _esConfig = null;
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
  const cur = CONFIG.teams.slice(0, n);
  while (cur.length < n) cur.push(`Avv ${cur.length}`);
  CONFIG.teams = cur;
  if (!CONFIG.teams.includes(CONFIG.myTeam)) CONFIG.myTeam = CONFIG.teams[0];
  persist(); recompute(); renderAll();
}

// stepper touch-safe (− valore +) al posto delle barre range
function stepper(target, label, step) {
  return `<div class="stepper">` +
    `<button class="stepbtn" data-sd="${target}" data-dd="${-step}">−</button>` +
    `<span class="sv">${label}</span>` +
    `<button class="stepbtn" data-sd="${target}" data-dd="${step}">+</button></div>`;
}
function applyStep(target, d) {
  if (target === "numTeams") { setNumTeams(CONFIG.numTeams + d); return; }
  if (target.startsWith("split:")) {
    const r = target.slice(6);
    CONFIG.splitPct[r] = Math.max(0, Math.min(90, (CONFIG.splitPct[r] || 0) + d));
    persist(); recompute(); renderAll(); return;
  }
  if (target.startsWith("roster:")) { // slot rosa per ruolo: config di LEGA (condivisa)
    const r = target.slice(7);
    CONFIG.roster = { ...CONFIG.roster, [r]: Math.max(0, Math.min(20, (CONFIG.roster[r] || 0) + d)) };
    persist(); recompute(); renderAll(); return;
  }
  if (target === "adjust") {
    if (!selectedId) return;
    CONFIG.adjust = CONFIG.adjust || {};
    const v = Math.max(-40, Math.min(40, (CONFIG.adjust[selectedId] || 0) + d));
    if (v === 0) delete CONFIG.adjust[selectedId]; else CONFIG.adjust[selectedId] = v;
    persist(); recompute(); renderAll(); return;
  }
}

function teamList() {
  return CONFIG.teams.map((name) => ({
    id: name === CONFIG.myTeam ? MY_TEAM : name,
    name,
    isMe: name === CONFIG.myTeam,
  }));
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
    // dati di giornata (opzionali: presenti solo a stagione avviata); non bloccano se assenti
    try {
      const gj = await fetch(`data/giornata.json${bust}`, { cache: forceNetwork ? "reload" : "default" }).then((r) => r.ok ? r.json() : null);
      if (gj) { GIORNATA = gj; save(LS.giornata, gj); }
    } catch { /* giornata.json non ancora pubblicato: ok */ }
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
  if (ui.screen === "analisi") renderAnalisi();
  if (ui.screen === "formazione") renderFormazione();
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
  const ban = document.getElementById("auctionBanner");
  if (ban) ban.style.display = CONFIG.auctionOpen === false ? "block" : "none";
  const card = document.getElementById("calledCard");
  const p = selectedId ? boardPlayer(selectedId) : null;
  if (!p) {
    card.className = "called empty";
    card.textContent = "Cerca un giocatore per vedere il prezzo consigliato.";
  } else {
    card.className = "called";
    const offer = buyFlow.price != null ? buyFlow.price : 1;
    let semClass, semTxt;
    if (p.taken) { semClass = "giallo"; semTxt = `✔ Preso da ${teamName(p.takenBy)} a ${p.takenPrice}`; }
    else { const v = offerVerdict(p, offer); semClass = v.cls; semTxt = v.txt; }
    const adjPct = (CONFIG.adjust && CONFIG.adjust[p.id]) || 0;
    const pnote = (CONFIG.notes && CONFIG.notes[p.id]) || "";
    // "tuo max reparto": crediti ancora previsti dal tuo piano di ripartizione per il ruolo
    const _sp = CONFIG.splitPct, _spTot = (_sp.P + _sp.D + _sp.C + _sp.A) || 1;
    const _roleBudget = Math.round((_sp[p.ruolo] / _spTot) * CONFIG.budgetPerTeam);
    const _roleSpent = (BOARD.me && BOARD.me.spentByRole && BOARD.me.spentByRole[p.ruolo]) || 0;
    const roleLeft = _roleBudget - _roleSpent;
    card.innerHTML = `
      <div class="top">
        <span class="rp ${p.ruolo}">${p.ruolo}</span>
        <div class="grow">
          <div class="nome">${esc(p.nome)}</div>
          <div class="sub">${esc(p.squadra)} · Quot ${p.qa ?? p.qi} · ${RUOLO_NOME[p.ruolo]}<span class="advonly"> · valore ${p.valoreBase}</span></div>
        </div>
        <span class="tier ${p.tier}">${p.tier}</span>
      </div>
      ${p.infortunato ? `<div class="injury">🩹 <b>Infortunato</b> — rientro previsto ${esc(p.rientro || "?")}${p.motivoInfortunio ? `<br><span class="im">${esc(p.motivoInfortunio)}</span>` : ""}</div>` : ""}
      <div class="price-grid">
        <div class="box"><div class="v big">${p.prezzoConsigliato}</div><div class="l">consigliato</div></div>
        <div class="box"><div class="v">${p.prezzoMax}</div><div class="l">max strappo</div></div>
        <div class="box"><div class="v">${BOARD.me.maxBid}</div><div class="l">tuo max</div></div>
        <div class="box" title="Crediti ancora previsti dal tuo piano di ripartizione per questo reparto (${_roleBudget} pianificati − ${_roleSpent} spesi)"><div class="v${roleLeft <= 0 ? " over" : ""}">${roleLeft}</div><div class="l">tuo max reparto</div></div>
      </div>
      <div class="srcinfo">📊 Rating ${p.overall ?? "—"} · Bonus attesi ${p.bonusAtteso ?? "—"} · Titolarità ${Math.round((p.titolarita || 0) * 100)}%${p.formazione ? ` · ${FORM_LABEL[p.formazione]}` : ""}${p.rigoreRank ? ` · ⚽ Rigorista${p.rigoreRank > 1 ? " (" + p.rigoreRank + "ª)" : ""}` : ""}${p.punizioneRank ? ` · 🎯 Punizioni${p.punizioneRank > 1 ? " (" + p.punizioneRank + "ª)" : ""}` : ""}${p.cornerRank ? ` · 🚩 Corner${p.cornerRank > 1 ? " (" + p.cornerRank + "ª)" : ""}` : ""}${p.goalBand ? ` · 🗞️ goal.com ${GOAL_BAND_LABEL[p.goalBand]}${p.goalFactor && p.goalFactor !== 1 ? ` <span class="adjv">${p.goalFactor > 1 ? "+" : ""}${Math.round((p.goalFactor - 1) * 100)}%</span>` : ""}` : ""}${adjPct ? ` · <span class="adjv">aggiust. ${adjPct > 0 ? "+" : ""}${adjPct}%</span>` : ""}${pnote ? `<br>📝 ${esc(pnote)}` : ""}</div>
      <div class="semaforo ${semClass}" id="offerSem"><span class="dot"></span>${semTxt}</div>
      ${p.taken ? `<button class="btn ghost full" data-undo="${p.id}">↩ Annulla acquisto</button>` : `
      <div class="buy-row">
        <button class="step" data-step="-1">−</button>
        <input id="priceInput" type="number" inputmode="numeric" min="1" value="${buyFlow.price != null ? buyFlow.price : 1}" />
        <button class="step" data-step="1">+</button>
      </div>
      ${buyActionsHtml(p)}`}
      <div class="adjust">
        <label>🎚️ Aggiusta valore <span class="hint2">(titolarità, infortuni, mercato…)</span></label>
        ${stepper("adjust", (adjPct > 0 ? "+" : "") + adjPct + "%", 5)}
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
      <div class="opp-grid">${CONFIG.teams.filter((o) => o !== CONFIG.myTeam).map((o) => `<button class="btn opp" data-oppteam="${esc(o)}">${esc(o)}</button>`).join("")}</div>
      <button class="btn ghost full" data-flow="idle" style="margin-top:8px">← indietro</button>`;
  }
  if (buyFlow.mode === "confirm") {
    const price = buyFlow.price != null ? buyFlow.price : 1;
    return `<div class="confirm-box">Assegni <b>${esc(p.nome)}</b><br>a <b>${esc(buyFlow.team)}</b> per <b>${price}</b> crediti?</div>
      <div class="buy-actions">
        <button class="btn me" data-confirm="1">✓ OK, conferma</button>
        <button class="btn ghost" data-flow="chooseOpp">← cambia</button>
      </div>`;
  }
  return `<div class="buy-actions">
      <button class="btn me" data-buy="me">✓ Preso da ${esc(CONFIG.myTeam)}</button>
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
    qi: (a, b) => (b.qa ?? b.qi ?? 0) - (a.qa ?? a.qi ?? 0),  // quotazione ATTUALE
    nome: (a, b) => a.nome.localeCompare(b.nome),
    squadra: (a, b) => a.squadra.localeCompare(b.squadra) || a.nome.localeCompare(b.nome),
  }[ui.sort];
  list.sort(cmp);
  el.innerHTML = list.slice(0, 300).map((p) => {
    // statistiche stagionali (da giornata.json, per fantaId) — mostrate solo a stagione avviata
    const gs = GIORNATA && GIORNATA.stats ? GIORNATA.stats[String(p.fantaId)] : null;
    const stat = gs && gs.pg > 0 ? ` · ${gs.pg}p · MV ${(+gs.mv).toFixed(1)} · FM ${(+gs.mfv).toFixed(1)}${gs.gol ? ` · ${gs.gol}g` : ""}${gs.ass ? ` · ${gs.ass}a` : ""}${gs.gs ? ` · ${gs.gs}gs` : ""}` : "";
    return `
    <div class="row ${p.taken ? "taken" : ""}" data-pick="${p.id}">
      <button class="star ${FAVORITES.has(p.id) ? "on" : ""}" data-fav="${p.id}">${FAVORITES.has(p.id) ? "★" : "☆"}</button>
      <span class="rp ${p.ruolo}">${p.ruolo}</span>
      <div class="grow"><div class="nome">${p.infortunato ? `<span class="advonly">🩹 </span>` : ""}${esc(p.nome)}</div>
        <div class="meta">${esc(p.squadra)}<span class="advonly"> · ${p.tier}</span> · Quot ${p.qa ?? p.qi}<span class="advonly"> · val ${Math.round(p.valoreBase)}${stat}${p.formazione ? " · " + FORM_SHORT[p.formazione] : ""}${p.rigoreRank ? ` · ⚽${p.rigoreRank}°` : ""}${p.punizioneRank ? ` · 🎯${p.punizioneRank}°` : ""}${p.cornerRank ? ` · 🚩${p.cornerRank}°` : ""}${p.infortunato ? " · 🩹 rientro " + esc(p.rientro || "?") : ""}</span>${p.taken ? " · preso " + teamName(p.takenBy) : ""}</div></div>
      <span class="price">${p.taken ? p.takenPrice : `<span class="advonly">${p.prezzoConsigliato}</span>`}</span>
    </div>`; }).join("") || `<div class="row"><span class="meta">Nessun giocatore.</span></div>`;
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
        <span class="bud">${s.budgetLeft} <small>/ ${CONFIG.budgetPerTeam}</small></span>
      </div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="slotline">${ROLES.map((r) => `<span class="slot ${r}">${r} ${(CONFIG.roster[r] || 0) - (s.slotsRemaining[r] ?? CONFIG.roster[r])}/${CONFIG.roster[r] || 0}</span>`).join("")}</div>
      ${rosterHtml}
    </div>`;
  }).join("");
}

// ---- ANALISI (post-asta) ----
// "Valore di listino": prezzo consigliato ricalcolato a stato VUOTO — una valuta
// equa in crediti, indipendente dall'andamento dell'asta e uguale per tutte le
// squadre. È il metro con cui misuriamo forza rosa, efficienza e affari/salassi.
function baselinePriceMap() {
  const base = computeBoard(adjustedPlayers(), [], effectiveConfig());
  return new Map(base.players.map((p) => [p.id, p.prezzoConsigliato]));
}

// Aggrega gli acquisti per squadra: spesa, valore di listino e conteggio per ruolo.
function teamAnalisi(baseP) {
  const roleOf = new Map(PLAYERS.map((p) => [p.id, p.ruolo]));
  const nameOf = new Map(PLAYERS.map((p) => [p.id, p.nome]));
  const blank = () => ({ P: 0, D: 0, C: 0, A: 0 });
  const stats = teamList().map((t) => ({
    id: t.id, name: t.name, isMe: t.isMe, spent: 0, value: 0, count: 0,
    spentByRole: blank(), valueByRole: blank(), countByRole: blank(),
  }));
  const byId = new Map(stats.map((s) => [s.id, s]));
  for (const pu of PURCHASES) {
    const s = byId.get(pu.team); if (!s) continue;
    const r = roleOf.get(pu.playerId) || pu.ruolo;
    if (!ROLES.includes(r)) continue;
    const price = Math.max(1, Math.round(pu.price || 1));
    const val = baseP.get(pu.playerId) ?? price; // fuori listone → valore neutro = prezzo pagato
    s.spent += price; s.spentByRole[r] += price;
    s.value += val;   s.valueByRole[r] += val;
    s.count += 1;     s.countByRole[r] += 1;
  }
  return { stats, nameOf, roleOf };
}

function forzaBadge(ratio) {
  if (ratio >= 1.15) return { cls: "forte", txt: "💪 Forte" };
  if (ratio <= 0.85) return { cls: "debole", txt: "⚠️ Debole" };
  return { cls: "media", txt: "➖ Nella media" };
}

function renderAnalisi() {
  const el = document.getElementById("analisiBody");
  if (!PURCHASES.length) {
    el.innerHTML = `<div class="called empty" style="margin-top:24px">Nessun acquisto registrato.<br>L'analisi comparirà man mano che assegni i giocatori nell'Asta.</div>`;
    return;
  }
  const baseP = baselinePriceMap();
  const { stats, nameOf, roleOf } = teamAnalisi(baseP);
  const N = stats.length || 1;
  const me = stats.find((s) => s.isMe) || stats[0];
  const budget = CONFIG.budgetPerTeam;
  const rosterTot = ROLES.reduce((a, r) => a + (CONFIG.roster[r] || 0), 0);

  const byForza = [...stats].sort((a, b) => b.value - a.value);
  const myRank = byForza.findIndex((s) => s.id === me.id) + 1;
  const avgRole = {}, maxRole = {}, roleRank = {};
  ROLES.forEach((r) => {
    avgRole[r] = stats.reduce((a, s) => a + s.valueByRole[r], 0) / N;
    maxRole[r] = Math.max(1, ...stats.map((s) => s.valueByRole[r]));
    roleRank[r] = [...stats].sort((a, b) => b.valueByRole[r] - a.valueByRole[r]).findIndex((s) => s.id === me.id) + 1;
  });

  const budgetLeft = budget - me.spent;
  const slotsLeft = rosterTot - me.count;
  const eff = me.spent > 0 ? me.value / me.spent : 0;
  const sp = CONFIG.splitPct, spTot = (sp.P + sp.D + sp.C + sp.A) || 1;

  // --- A. Riepilogo ---
  const nota = slotsLeft > 0
    ? `<div class="an-note">⏳ Asta in corso: analisi parziale (${me.count}/${rosterTot} giocatori, ${slotsLeft} slot liberi).</div>`
    : "";
  const riepilogo = `
    <div class="an-grid">
      <div class="an-card"><div class="v">#${myRank}<small>/${N}</small></div><div class="l">Forza rosa</div></div>
      <div class="an-card"><div class="v">${me.value}</div><div class="l">Valore rosa (cr)</div></div>
      <div class="an-card"><div class="v">${me.spent}<small>/${budget}</small></div><div class="l">Spesi</div></div>
      <div class="an-card"><div class="v">${budgetLeft}</div><div class="l">Crediti liberi${slotsLeft > 0 ? ` · ${slotsLeft} slot` : ""}</div></div>
    </div>
    <div class="an-eff">Efficienza rosa: <b>×${eff.toFixed(2)}</b> valore/credito ${eff >= 1 ? "🟢" : "🔴"} <span class="hint">(quanto valore di listino hai preso per ogni credito speso)</span></div>`;

  // --- B. Spesa per reparto ---
  const spesaRep = ROLES.map((r) => {
    const share = me.spent > 0 ? (me.spentByRole[r] / me.spent) * 100 : 0;
    const plan = (sp[r] / spTot) * 100;
    return `<div class="an-row">
      <span class="rp ${r}">${r}</span>
      <div class="grow">
        <div class="an-line"><b>${me.spentByRole[r]}</b> cr · ${Math.round(share)}% <span class="an-plan">piano ${Math.round(plan)}%</span> · ${me.countByRole[r]} giocatori</div>
        <div class="an-bar"><i class="fill-${r}" style="width:${Math.min(100, share)}%"></i><span class="tick" style="left:${Math.min(100, plan)}%"></span></div>
      </div>
    </div>`;
  }).join("");

  // --- C. Forza per reparto vs lega ---
  const forzaRep = ROLES.map((r) => {
    const ratio = avgRole[r] > 0 ? me.valueByRole[r] / avgRole[r] : 1;
    const b = forzaBadge(ratio);
    const w = (me.valueByRole[r] / maxRole[r]) * 100;
    const avgW = (avgRole[r] / maxRole[r]) * 100;
    return `<div class="an-row">
      <span class="rp ${r}">${r}</span>
      <div class="grow">
        <div class="an-line"><span class="badge ${b.cls}">${b.txt}</span> #${roleRank[r]}/${N} · tu <b>${me.valueByRole[r]}</b> · media ${Math.round(avgRole[r])}</div>
        <div class="an-bar"><i class="fill-${r}" style="width:${Math.min(100, w)}%"></i><span class="tick" style="left:${Math.min(100, avgW)}%"></span></div>
      </div>
    </div>`;
  }).join("");

  // --- D. Classifica squadre (forza) ---
  const classifica = byForza.map((s, i) => {
    const e = s.spent > 0 ? s.value / s.spent : 0;
    return `<div class="row ${s.id === me.id ? "an-me" : ""}">
      <span class="an-pos">${i + 1}</span>
      <div class="grow"><div class="nome">${esc(s.name)}</div>
        <div class="meta">spesi ${s.spent} · ${s.count} giocatori · eff ×${e.toFixed(2)}</div></div>
      <span class="price">${s.value}</span>
    </div>`;
  }).join("");

  // --- E. Affari & salassi (miei giocatori) ---
  const mine = PURCHASES.filter((pu) => pu.team === me.id).map((pu) => {
    const paid = Math.max(1, Math.round(pu.price || 1));
    const base = baseP.get(pu.playerId) ?? paid;
    return { nome: nameOf.get(pu.playerId) || pu.nome || pu.playerId, ruolo: roleOf.get(pu.playerId) || pu.ruolo || "?", paid, base, delta: paid - base };
  });
  const netto = mine.reduce((a, x) => a + x.delta, 0);
  const affari = mine.filter((x) => x.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 3);
  const salassi = mine.filter((x) => x.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 3);
  const dealRow = (x, kind) => `<div class="row">
      <span class="rp ${x.ruolo}">${x.ruolo}</span>
      <div class="grow"><div class="nome">${esc(x.nome)}</div>
        <div class="meta">pagato ${x.paid} · listino ${x.base}</div></div>
      <span class="an-delta ${kind}">${x.delta > 0 ? "+" : ""}${x.delta}</span>
    </div>`;
  const affariHtml = affari.length ? affari.map((x) => dealRow(x, "good")).join("") : `<div class="row"><span class="meta">Nessun affare sotto il listino.</span></div>`;
  const salassiHtml = salassi.length ? salassi.map((x) => dealRow(x, "bad")).join("") : `<div class="row"><span class="meta">Nessun sovrapprezzo rilevante.</span></div>`;
  const nettoTxt = netto === 0 ? "in pari col listino"
    : netto < 0 ? `<b class="an-delta good">${netto}</b> crediti risparmiati sul valore di listino`
    : `<b class="an-delta bad">+${netto}</b> crediti spesi oltre il valore di listino`;

  el.innerHTML = `
    ${nota}
    <div class="section-title">Riepilogo — ${esc(me.name)}</div>
    ${riepilogo}
    <div class="section-title">Spesa per reparto</div>
    <div class="an-block">${spesaRep}</div>
    <div class="section-title">Forza per reparto (vs media lega)</div>
    <div class="an-block">${forzaRep}</div>
    <div class="section-title">Classifica squadre per forza rosa</div>
    <div class="list">${classifica}</div>
    <div class="section-title">💚 I tuoi affari</div>
    <div class="list">${affariHtml}</div>
    <div class="section-title">💸 I tuoi salassi</div>
    <div class="list">${salassiHtml}</div>
    <div class="an-note" style="margin-top:12px">Saldo: ${nettoTxt}.</div>`;
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
    `<br>Fonte: ${esc(META.fonte || "—")}` +
    `<br><span style="opacity:.55">app ${APP_VERSION}</span>`;

  const at = document.getElementById("auctionToggle");
  if (at) {
    const open = CONFIG.auctionOpen !== false;
    at.textContent = open ? "🔓 Asta APERTA — tocca per chiudere" : "🔒 Asta CHIUSA — tocca per aprire";
    at.className = "btn full " + (open ? "me" : "danger");
    document.getElementById("auctionHint").textContent = open
      ? "Aperta: si possono modificare le rose. Chiudila a mercato finito."
      : "Chiusa: nessuno può modificare le rose (né tu né gli avversari) finché non riapri.";
  }
  document.getElementById("numTeamsStepper").innerHTML = stepper("numTeams", CONFIG.numTeams + " squadre", 1);
  const rs = document.getElementById("rosterSettings");
  if (rs) rs.innerHTML = ROLES.map((r) => `
    <div class="setting stepper-row">
      <label>${RUOLO_NOME[r]}</label>
      ${stepper("roster:" + r, (CONFIG.roster[r] ?? 0) + "", 1)}
    </div>`).join("");
  updateRosterSum();
  const sp = document.getElementById("splitSettings");
  sp.innerHTML = ROLES.map((r) => `
    <div class="setting stepper-row">
      <label>${RUOLO_NOME[r]}</label>
      ${stepper("split:" + r, CONFIG.splitPct[r] + "%", 1)}
    </div>`).join("");
  updateSplitSum();

  const bt = document.getElementById("budgetPerTeam");
  if (bt && document.activeElement !== bt) bt.value = CONFIG.budgetPerTeam;
  const ts = document.getElementById("teamsSettings");
  if (ts) ts.innerHTML = CONFIG.teams.map((name, i) => {
    const me = name === CONFIG.myTeam;
    return `<div class="teamrow ${me ? "me" : ""}">
      <button class="teammark ${me ? "on" : ""}" data-myteam="${i}" title="Segna come la mia squadra">${me ? "⭐" : "☆"}</button>
      <input type="text" data-teamname="${i}" value="${esc(name)}" />
    </div>`;
  }).join("");
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
  if (auctionClosed()) return;
  const hist = load(LS.history, []);
  const s = hist[idx];
  if (!s) return;
  const d = new Date(s.ts);
  const when = d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (!confirm(`Ripristinare il backup delle ${when} (${(s.purchases || []).length} acquisti)?\n⚠️ Riscrive l'asta di TUTTA la lega (sincronizzata su tutti i dispositivi). Lo stato attuale verrà prima salvato nei backup.`)) return;
  snapshotNow(); // salva lo stato corrente prima di sovrascrivere
  if (s.config) { CONFIG = normalizeConfig({ ...defaultConfig(), ...s.config }); persist(); }
  if (s.favorites) { FAVORITES = new Set(s.favorites); save(LS.fav, [...FAVORITES]); }
  applyPurchasesTarget(Array.isArray(s.purchases) ? s.purchases : []); // riallinea via mosse (anche sul cloud)
  snapshotNow();
  recompute(); renderAll(); toast("Backup ripristinato");
}
function updateRosterSum() {
  const el = document.getElementById("rosterSum"); if (!el) return;
  const r = CONFIG.roster;
  const tot = ROLES.reduce((a, x) => a + (r[x] || 0), 0);
  el.textContent = `Totale ${tot} giocatori a squadra · ` + ROLES.map((x) => `${r[x] || 0}${x}`).join(" ");
}
function updateSplitSum() {
  const p = CONFIG.splitPct; const tot = p.P + p.D + p.C + p.A;
  const el = document.getElementById("splitSum");
  if (el) el.innerHTML = `Totale ${tot}% (normalizzato automaticamente). In crediti per la tua rosa (su ${CONFIG.budgetPerTeam}): ` +
    ROLES.map((r) => `${r} ~${Math.round((p[r] / tot) * CONFIG.budgetPerTeam)}`).join(" · ");
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

// gate: quando l'asta è chiusa (config di lega), niente modifiche alle rose per nessuno
function auctionClosed() {
  if (CONFIG.auctionOpen === false) { toast("🔒 Asta chiusa: modifiche disabilitate"); return true; }
  return false;
}

function recordPurchase(team) {
  if (auctionClosed()) return;
  const p = boardPlayer(selectedId); if (!p) return;
  // blocca se la squadra ha già raggiunto il numero massimo di giocatori per quel ruolo
  const ts = BOARD.teams.find((t) => t.id === team);
  const max = CONFIG.roster[p.ruolo] || 0;
  if (ts && ts.slotsRemaining && ts.slotsRemaining[p.ruolo] <= 0) {
    toast(`${teamName(team)} ha già ${max} ${p.ruolo}: reparto al completo`);
    return;
  }
  const input = document.getElementById("priceInput");
  const price = Math.max(1, Math.round(Number(input?.value) || p.prezzoConsigliato));
  // salvo anche nome/ruolo/squadra: l'acquisto resta valido anche se il listone cambia
  emitMove({ type: "buy", playerId: selectedId, team, price, nome: p.nome, ruolo: p.ruolo, squadra: p.squadra });
  recompute();
  toast(`${p.nome} → ${teamName(team)} a ${price}`);
  selectedId = null;
  buyFlow = { mode: "idle", team: null, price: null };
  renderAll();
}
function undoPurchaseByPlayer(id) {
  if (auctionClosed()) return;
  const pu = PURCHASES.find((p) => p.playerId === id);
  const pl = PLAYERS.find((x) => x.id === id);
  emitMove({ type: "undo", playerId: id });
  recompute();
  toast(`Annullato: ${pl ? pl.nome : (pu && pu.nome) || "acquisto"}`);
  renderAll();
}
function undoPurchaseIdx(idx) {
  if (idx >= 0 && idx < PURCHASES.length) undoPurchaseByPlayer(PURCHASES[idx].playerId);
}
function movePurchase(pid, toTeam) {
  if (auctionClosed()) return;
  const pu = PURCHASES.find((p) => p.playerId === pid);
  if (!pu || pu.team === toTeam) return;
  emitMove({ type: "move", playerId: pid, team: toTeam, price: pu.price, nome: pu.nome, ruolo: pu.ruolo, squadra: pu.squadra });
  recompute(); renderAll();
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

// ---------------------------------------------------------------------------
// FORMAZIONE (stagione) — scheda per-giocatore + XI consigliato. Solo FULL/personale.
// Legge la MIA rosa (PURCHASES della mia squadra) + giornata.json (statistiche +
// probabili + fixtures). Modalità DEMO: rosa e dati casuali IN MEMORIA (nessun sync,
// nessuna modifica alla lega vera) per provare grafica e uso.
// ---------------------------------------------------------------------------
const MODULI = { "3-4-3": [3,4,3], "3-5-2": [3,5,2], "4-3-3": [4,3,3], "4-4-2": [4,4,2], "4-5-1": [4,5,1], "5-3-2": [5,3,2], "5-4-1": [5,4,1] };
const _deac = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
// nome breve per le righe compatte: i nostri nomi sono "Cognome Nome" → tengo il COGNOME
// (anche composto, es. "De Ketelaere", "Del Prato"), scartando solo il nome di battesimo finale.
const shortName = (n) => { const t = String(n || "").trim().split(/\s+/); return t.length > 1 ? t.slice(0, -1).join(" ") : (n || ""); };

function giornataActive() { return formDemo ? formDemo.g : GIORNATA; }

// resa attesa: fantamedia (se ci sono partite) o media di ruolo, moderata dalla disponibilità
function expScore(st, prob, injured) {
  if (injured) return 0;
  const base = (st && st.pg > 0 && st.mfv) ? st.mfv : 6.0;
  let avail;
  if (!prob) avail = 0.15;                                   // non tra i probabili
  else if (prob.status === "titolare") avail = (prob.perc ?? 70) / 100;
  else avail = ((prob.perc ?? 0) / 100) * 0.35;             // riserva: pochi minuti
  return base * avail;
}
function labelFor(prob, injured) {
  if (injured) return { t: "Panchina", k: "no" };
  if (!prob) return { t: "Panchina", k: "no" };
  if (prob.status === "titolare") return (prob.perc ?? 0) >= 75 ? { t: "Schiera", k: "go" } : { t: "Dubbio", k: "maybe" };
  return (prob.perc ?? 0) >= 55 ? { t: "Dubbio", k: "maybe" } : { t: "Panchina", k: "no" };
}
function commentSnippet(nome, squadra, g) {
  const txt = g && g.commento ? g.commento[squadra] : null;
  if (!txt) return "";
  const sur = _deac(nome).split(" ")[0];
  const frasi = txt.split(/(?<=[.!?])\s+/);
  const hit = frasi.find((f) => _deac(f).includes(sur));
  return hit || "";
}
// migliore XI sui 7 moduli: per ogni modulo prende i top per resa nei ruoli richiesti
function bestXI(players) {
  const byRole = { P: [], D: [], C: [], A: [] };
  players.forEach((p) => (byRole[p.ruolo] || (byRole[p.ruolo] = [])).push(p));
  for (const r of ROLES) byRole[r].sort((a, b) => b._exp - a._exp);
  let best = null;
  for (const [mod, [nd, nc, na]] of Object.entries(MODULI)) {
    if (byRole.P.length < 1 || byRole.D.length < nd || byRole.C.length < nc || byRole.A.length < na) continue;
    const xi = [byRole.P[0], ...byRole.D.slice(0, nd), ...byRole.C.slice(0, nc), ...byRole.A.slice(0, na)];
    const tot = xi.reduce((s, p) => s + p._exp, 0);
    if (!best || tot > best.tot) best = { mod, tot, xi };
  }
  return best;
}

function renderFormazione() {
  const el = document.getElementById("formazioneBody");
  // demo raggiungibile solo via URL ?fdemo=1 (backdoor per rifiniture; nessun pulsante visibile)
  if (!formDemo && /[?&]fdemo\b/.test(location.search) && PLAYERS.length) formDemo = buildFormDemo();
  const g = giornataActive();
  // rosa attiva: demo oppure la mia rosa reale (acquisti della mia squadra)
  let roster;
  if (formDemo) roster = formDemo.roster;
  else roster = PURCHASES.filter((pu) => pu.team === MY_TEAM).map((pu) => {
    const pl = PLAYERS.find((x) => x.id === pu.playerId) || { id: pu.playerId, nome: pu.nome || pu.playerId, ruolo: pu.ruolo || "C", squadra: pu.squadra || "?" };
    return { id: pl.id, fantaId: pl.fantaId, nome: pl.nome, ruolo: pl.ruolo, squadra: pl.squadra, infortunato: !!pl.infortunato, rientro: pl.rientro };
  });

  // in uso normale nessun pulsante demo; se la demo è attiva (via URL) mostro solo l'uscita
  const demoBtn = formDemo ? `<button class="btn ghost on" data-formdemo="1">🧪 Esci dalla demo</button>` : "";
  const head = `<div class="fmz-head"><div class="section-title">🧩 Formazione di giornata${formDemo ? ` <span class="demo-badge">DEMO</span>` : ""}</div>${demoBtn}</div>`;

  if (!roster.length) {
    el.innerHTML = head + `<div class="hint" style="margin-top:12px">La tua rosa è ancora vuota: la <b>Formazione</b> si popola dopo l'asta (con la tua rosa) e a campionato iniziato, con i dati di giornata aggiornati automaticamente.</div>`;
    return;
  }
  if (!g) {
    el.innerHTML = head + `<div class="hint" style="margin-top:12px">Dati di giornata non ancora disponibili (probabili/statistiche). Compaiono a campionato avviato, oppure attiva i dati demo.</div>`;
    return;
  }

  // arricchisci ogni giocatore con stat, probabile, match, resa, etichetta
  roster.forEach((p) => {
    const k = String(p.fantaId ?? p.id);  // giornata.json è chiavato sul fantaId
    p._st = (g.stats || {})[k] || null;
    p._prob = (g.probabili || {})[k] || null;
    p._match = (g.teamMatch || {})[p.squadra] || null;
    p._exp = expScore(p._st, p._prob, p.infortunato);
    p._lab = labelFor(p._prob, p.infortunato);
    p._note = commentSnippet(p.nome, p.squadra, g);
  });

  // XI consigliato
  const xi = bestXI(roster);
  const xiIds = new Set(xi ? xi.xi.map((p) => p.id) : []);
  let xiHtml = "";
  if (xi) {
    const line = (r) => xi.xi.filter((p) => p.ruolo === r).map((p) => esc(shortName(p.nome))).join(", ");
    // panchina come gli 11: righe per ruolo, dentro ogni ruolo in ordine di prob. di subentro (resa attesa)
    const bench = roster.filter((p) => !xiIds.has(p.id)).sort((a, b) => b._exp - a._exp);
    const benchLine = (r) => bench.filter((p) => p.ruolo === r).map((p) => esc(shortName(p.nome))).join(", ");
    const benchHtml = bench.length ? `<div class="xi-bench">
      <div class="xi-top"><b>Panchina consigliata</b> <span class="meta">(per ruolo · ordine di subentro)</span></div>
      ${ROLES.map((r) => { const l = benchLine(r); return l ? `<div class="xi-line"><span class="rp ${r}">${r}</span> ${l}</div>` : ""; }).join("")}
    </div>` : "";
    xiHtml = `<div class="fmz-xi">
      <div class="xi-top"><b>11 consigliato</b> · modulo <b>${xi.mod}</b> <span class="meta">(resa attesa ${xi.tot.toFixed(1)})</span></div>
      ${ROLES.map((r) => `<div class="xi-line"><span class="rp ${r}">${r}</span> ${esc(line(r)) || "<span class='meta'>—</span>"}</div>`).join("")}
      ${benchHtml}
    </div>`;
  }

  const ord = { go: 0, maybe: 1, no: 2 };
  const RUOLI_NOME = { P: "Portieri", D: "Difensori", C: "Centrocampisti", A: "Attaccanti" };
  const reparti = ROLES.map((r) => {
    const list = roster.filter((p) => p.ruolo === r).sort((a, b) => ord[a._lab.k] - ord[b._lab.k] || b._exp - a._exp);
    if (!list.length) return "";
    return `<div class="fmz-reparto"><div class="rep-title"><span class="rp ${r}">${r}</span> ${RUOLI_NOME[r]}</div>${list.map((p) => card(p, xiIds.has(p.id))).join("")}</div>`;
  }).join("");

  el.innerHTML = head + xiHtml + reparti;

  function card(p, inXI) {
    const st = p._st, pr = p._prob, m = p._match;
    const perc = pr && pr.perc != null ? pr.perc + "%" : "";
    const probTxt = p.infortunato ? `🩹 infortunato${p.rientro ? " · rientro " + esc(p.rientro) : ""}`
      : pr ? (pr.status === "titolare" ? `${pr.conf === "alta" ? "🟢" : "🟡"} titolare ${perc}` : `⚪ riserva ${perc} (subentro)`)
      : "⚪ non tra i probabili";
    const club = esc(String(p.squadra).toUpperCase());  // club del giocatore in MAIUSCOLO
    // sempre "Casa - Trasferta": se il club gioca fuori, prima l'avversario (casa) poi il club
    const matchTxt = m ? (m.home ? `${club} - ${esc(m.opponent)} 🏠` : `${esc(m.opponent)} - ${club} ✈️`) : club;
    const fmt = (n) => (typeof n === "number" ? n.toFixed(2) : (n || 0));
    const statTxt = st ? `${st.pg} pres · MV ${fmt(st.mv)} · FM ${fmt(st.mfv)} · ${st.gol} gol${st.gs ? ` · ${st.gs} subiti` : ""}${st.ass ? ` · ${st.ass} assist` : ""}` : "nessuna statistica";
    return `<div class="fmz-card ${p._lab.k}${inXI ? " in-xi" : ""}">
      <div class="fc-head"><span class="tag ${p._lab.k}">${p._lab.t}</span><span class="fc-name">${esc(p.nome)}</span><span class="fc-team">${matchTxt}</span>${inXI ? `<span class="xi-badge">11</span>` : ""}</div>
      <div class="fc-prob">${probTxt}</div>
      <div class="fc-stat">${statTxt}</div>
      ${p._note ? `<div class="fc-note">💬 ${esc(p._note)}</div>` : ""}
    </div>`;
  }
}

// genera una rosa + dati di giornata CASUALI, in memoria, per provare la schermata
function buildFormDemo() {
  const pick = (arr, n) => { const a = arr.slice(); const out = []; while (out.length < n && a.length) out.push(a.splice(Math.floor(Math.random() * a.length), 1)[0]); return out; };
  const pool = { P: [], D: [], C: [], A: [] };
  (PLAYERS.length ? PLAYERS : []).forEach((p) => pool[p.ruolo] && pool[p.ruolo].push(p));
  const need = { P: 3, D: 8, C: 8, A: 6 };
  const roster = [];
  for (const r of ROLES) pick(pool[r], need[r]).forEach((p) => roster.push({ id: p.id, fantaId: p.fantaId, nome: p.nome, ruolo: p.ruolo, squadra: p.squadra, infortunato: Math.random() < 0.08 }));
  const stats = {}, probabili = {}, teamMatch = {}, commento = {};
  const avversari = ["Inter", "Milan", "Juventus", "Napoli", "Roma", "Lazio", "Atalanta", "Bologna"];
  roster.forEach((p) => {
    const k = String(p.fantaId ?? p.id);  // stessa chiave usata in render (fantaId)
    const pg = Math.floor(Math.random() * 16);
    const mv = +(5.5 + Math.random() * 1.6).toFixed(2);
    const bonus = p.ruolo === "A" ? Math.random() * 1.8 : p.ruolo === "C" ? Math.random() * 1.2 : Math.random() * 0.5;
    stats[k] = { pg, mv, mfv: +(mv + bonus).toFixed(2), gol: p.ruolo === "P" ? 0 : Math.floor(Math.random() * (p.ruolo === "A" ? 9 : 4)), gs: p.ruolo === "P" ? Math.floor(Math.random() * 14) : 0, ass: Math.floor(Math.random() * 5), rigSeg: 0, rigCal: 0, rp: 0, amm: Math.floor(Math.random() * 5), esp: 0 };
    const roll = Math.random();
    if (roll < 0.55) probabili[k] = { status: "titolare", perc: 75 + Math.floor(Math.random() * 26), conf: "alta", ruolo: p.ruolo };
    else if (roll < 0.75) probabili[k] = { status: "titolare", perc: 50 + Math.floor(Math.random() * 25), conf: "media", ruolo: p.ruolo };
    else probabili[k] = { status: "riserva", perc: 5 + Math.floor(Math.random() * 60), conf: "media", ruolo: p.ruolo };
    if (!teamMatch[p.squadra]) { const opp = avversari.filter((t) => t !== p.squadra); teamMatch[p.squadra] = { opponent: opp[Math.floor(Math.random() * opp.length)], home: Math.random() < 0.5 }; }
    commento[p.squadra] = (commento[p.squadra] || "") + `${p.nome} ${["è in buona condizione.", "recupera e s'avvia verso una maglia.", "è in ballottaggio fino all'ultimo.", "parte favorito per una maglia.", "potrebbe rifiatare."][Math.floor(Math.random() * 5)]} `;
  });
  return { roster, g: { stats, probabili, teamMatch, commento, demo: true } };
}

function setScreen(name) {
  ui.screen = name;
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === `screen-${name}`));
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.screen === name));
  renderAll();
}

function teamName(id) {
  if (id === MY_TEAM) return CONFIG.myTeam;
  return id;
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// pulsante "×" per svuotare un input di ricerca in un tocco (mostrato solo se c'è testo)
function wireSearchClear(id) {
  const inp = document.getElementById(id);
  const btn = inp && inp.parentElement.querySelector(".search-clear");
  if (!inp || !btn) return;
  const upd = () => btn.classList.toggle("show", inp.value.length > 0);
  inp.addEventListener("input", upd);
  btn.addEventListener("click", () => { inp.value = ""; inp.dispatchEvent(new Event("input", { bubbles: true })); inp.focus(); });
  upd();
}

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
        <div class="grow"><div class="nome">${esc(p.nome)}</div><div class="meta">${esc(p.squadra)}<span class="advonly"> · ${p.tier}</span></div></div>
        <span class="price">${p.taken ? "preso" : `<span class="advonly">${p.prezzoConsigliato}</span>`}</span>
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
  document.body.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target && e.target.id === "gatePw") { e.preventDefault(); submitGate(); }
  });
  document.body.addEventListener("click", (e) => {
    if (justDragged) return; // ignora il click sintetico dopo un trascinamento
    if (e.target.closest("#gateBtn")) { submitGate(); return; }
    const fdemo = e.target.closest("[data-formdemo]");
    if (fdemo) { formDemo = formDemo ? null : buildFormDemo(); renderFormazione(); return; }
    const sd = e.target.closest("[data-sd]");
    if (sd) { applyStep(sd.dataset.sd, Number(sd.dataset.dd)); return; }
    const remP = e.target.closest("[data-remove-purchase]");
    if (remP) { undoPurchaseByPlayer(remP.dataset.removePurchase); return; }
    const fav = e.target.closest("[data-fav]");
    if (fav) { e.stopPropagation(); toggleFav(fav.dataset.fav); return; }
    const pick = e.target.closest("[data-pick]");
    if (pick) { selectPlayer(pick.dataset.pick); return; }
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
  wireSearchClear("search"); wireSearchClear("searchL");
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
  document.getElementById("budgetPerTeam").addEventListener("change", (e) => {
    const v = Math.round(Number(e.target.value));
    if (!v || v < 1) { e.target.value = CONFIG.budgetPerTeam; return; } // valore non valido → ripristina
    CONFIG.budgetPerTeam = v; persist(); recompute(); renderAll();
  });
  document.getElementById("teamsSettings").addEventListener("change", (e) => {
    const i = e.target.dataset.teamname; if (i == null) return;
    const idx = Number(i), old = CONFIG.teams[idx];
    const val = e.target.value.trim() || `Avv ${idx}`;
    if (CONFIG.myTeam === old) CONFIG.myTeam = val; // rinomino la MIA squadra → seguo il nuovo nome
    CONFIG.teams[idx] = val;
    persist(); recompute(); renderAll();
  });
  document.getElementById("teamsSettings").addEventListener("click", (e) => {
    const mk = e.target.closest("[data-myteam]"); if (!mk) return;
    CONFIG.myTeam = CONFIG.teams[Number(mk.dataset.myteam)]; // scelta LOCALE (non condivisa sul cloud)
    save(LS.config, CONFIG); rebuildPurchases(); recompute(); renderAll();
  });
  document.getElementById("auctionToggle").addEventListener("click", () => {
    CONFIG.auctionOpen = CONFIG.auctionOpen === false; // chiusa → apri, aperta → chiudi
    persist(); pushConfig(); recompute(); renderAll(); // push IMMEDIATO (non solo debounce)
    toast(CONFIG.auctionOpen ? "🔓 Asta aperta" : "🔒 Asta chiusa");
  });
  document.getElementById("resetBtn").addEventListener("click", async () => {
    const online = SYNC.on && !!movesUrl(); // il reset raggiunge la lega solo se la sync è attiva
    const msg = online
      ? "⚠️ Azzerare l'asta per TUTTA la lega? Cancella tutti gli acquisti dal cloud e da ogni dispositivo collegato. Lo stato attuale resta nei backup locali. Procedere?"
      : "⚠️ SYNC SPENTA: il reset azzererà SOLO questo dispositivo, NON la lega. Per azzerare tutti attiva prima la sincronizzazione. Procedere lo stesso (solo qui)?";
    if (!confirm(msg)) return;
    snapshotNow();                              // salva lo stato pre-reset (recuperabile in locale)
    const now = Date.now();
    CONFIG.resetAt = now; save(LS.config, CONFIG); resetSeen = now; save(LS.resetSeen, now);
    MOVES = []; saveMoves(); rebuildPurchases(); // pulizia locale immediata
    await deleteCloudMoves();                    // svuota il log condiviso
    pushConfig();                                // pubblica resetAt → gli altri dispositivi si puliscono
    selectedId = null; recompute(); renderAll();
    toast(online ? "Asta azzerata per tutta la lega" : "⚠️ Azzerata solo qui (sync spenta)"); setScreen("asta");
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
  document.getElementById("disguiseToggle").addEventListener("click", () => setDiscreet(!DISCREET));
  document.getElementById("discreetToggle").addEventListener("click", () => setDiscreet(!DISCREET));
  document.getElementById("showTabsToggle").addEventListener("click", () => setShowTabs(!SHOWTABS));
  applyDisguise(); // applica subito l'aspetto salvato (evita il flash della vista piena)
  document.getElementById("exportBtn").addEventListener("click", exportBackup);
  document.getElementById("importBtn").addEventListener("click", () => document.getElementById("importFile").click());
  document.getElementById("importFile").addEventListener("change", importBackup);
  setupTeamDnD();
}

function toggleFav(id) {
  if (FAVORITES.has(id)) FAVORITES.delete(id); else FAVORITES.add(id);
  save(LS.fav, [...FAVORITES]); // i preferiti sono personali: solo locali, non vanno sul cloud
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
  if (auctionClosed()) { e.target.value = ""; return; }
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const d = JSON.parse(reader.result);
      if (d.config) { CONFIG = normalizeConfig({ ...defaultConfig(), ...d.config }); persist(); }
      if (d.favorites) { FAVORITES = new Set(d.favorites); save(LS.fav, [...FAVORITES]); }
      if (d.purchases) applyPurchasesTarget(d.purchases); // riallinea via mosse (fonde con l'asta condivisa)
      snapshotNow(); recompute(); renderAll(); toast("Backup importato");
    } catch { toast("File non valido"); }
  };
  reader.readAsText(file);
  e.target.value = "";
}

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------
// Schermata di sblocco (master password) sulla prima apertura di QUESTO dispositivo.
function renderGate() {
  const el = document.getElementById("gate"); if (!el) return;
  if (unlocked) { el.style.display = "none"; return; }
  el.style.display = "flex";
  el.innerHTML = `<div class="gate-card">
    <div class="gate-logo">FA</div>
    <h2>FantaAsta</h2>
    <p>Accesso riservato all'admin.<br>Inserisci la password.</p>
    <input id="gatePw" type="password" autocomplete="off" placeholder="password" />
    <button class="btn me full" id="gateBtn" style="margin-top:10px">Entra</button>
    <div class="gate-err" id="gateErr"></div>
  </div>`;
  const inp = document.getElementById("gatePw"); if (inp) setTimeout(() => inp.focus(), 50);
}
function submitGate() {
  const inp = document.getElementById("gatePw"); const pw = inp ? inp.value : "";
  checkMasterPw(pw).then((ok) => {
    if (ok) { unlocked = true; save(LS.unlocked, true); renderGate(); bootApp(); }
    else { const er = document.getElementById("gateErr"); if (er) er.textContent = "Password errata"; if (inp) { inp.value = ""; inp.focus(); } }
  });
}

async function init() {
  wire();
  renderGate();
  if (unlocked) bootApp();   // se già sbloccato su questo dispositivo, parti; altrimenti aspetta la password
}
let _booted = false;
async function bootApp() {
  if (_booted) return; _booted = true;
  // chiedi al browser di NON sfrattare i dati salvati (importante durante l'asta)
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch {}
  try { await loadData(false); }
  catch { document.getElementById("calledCard").textContent = "Impossibile caricare i dati."; return; }
  rebuildPurchases(); // deriva gli acquisti dal log di mosse locale prima del primo calcolo
  recompute();
  renderAll();
  if (SYNC.on) startSync();
  // tornando in primo piano, riallinea SUBITO (mobile sospende SSE/timer in background)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && SYNC.on) { pullOnce(); connectSSE(); }
  });
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
