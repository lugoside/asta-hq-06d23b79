// engine.js — motore di prezzo dinamico per l'asta del fantacalcio.
//
// Funzioni PURE (nessun DOM): usabili sia nel browser (import da app.js) sia in
// Node per i test. Il cuore è computeBoard(), che dato l'insieme dei giocatori,
// la lista degli acquisti già avvenuti e la configurazione della lega, ricalcola
// per OGNI giocatore disponibile un prezzo consigliato che tiene conto di:
//   - inflazione   (crediti ancora sul mercato / valore ancora disponibile)
//   - scarsità     (se i big di un ruolo sono già andati, i rimanenti salgono)
//   - budget/slot personali (quanto TU puoi/dovresti spingerti)
//
// Il modello per ruolo: il "pool" di crediti ancora destinato al ruolo viene
// distribuito sui giocatori che verranno realmente comprati (i top-N per valore,
// dove N = slot ancora liberi nel ruolo in tutta la lega), con un credito di
// riserva per slot. Chi sta sotto la soglia degli slot è "filler" → prezzo 1.

// ---------------------------------------------------------------------------
// Configurazione di default (lega di Valerio). Tutto sovrascrivibile dall'app.
// ---------------------------------------------------------------------------
export const DEFAULT_CONFIG = {
  numTeams: 10,
  budgetPerTeam: 500,
  roster: { P: 3, D: 8, C: 8, A: 6 }, // 25 giocatori
  // ripartizione "equilibrata" del budget per ruolo (somma = 1)
  budgetSplit: { P: 0.08, D: 0.14, C: 0.28, A: 0.50 },
  // esponente di concentrazione: >1 concentra i crediti sui top del ruolo
  concentration: 1.15,
  // "strappo" massimo consigliato = consigliato * (1 + strappo)
  strappo: 0.15,
};

export const ROLES = ["P", "D", "C", "A"];
export const MY_TEAM = "__ME__"; // id speciale per la mia squadra (solo lato UI locale)

// ---------------------------------------------------------------------------
// Log di mosse append-only → stato acquisti (modello condiviso multi-writer).
//
// Ogni mossa è un evento assoluto (non incrementale):
//   { uid, type: "buy"|"undo"|"move", playerId, team, price?, nome?, ruolo?, squadra?, ts, byDevice }
// - buy  : il giocatore è assegnato a `team` per `price`
// - undo : il giocatore torna disponibile
// - move : il giocatore passa a `team` (prezzo invariato salvo `price` esplicito)
//
// reduceMoves riduce il log allo stato finale `purchases[]` che l'engine già
// consuma. Proprietà chiave:
//   * DETERMINISTICO: dipende solo dall'insieme delle mosse, non dall'ordine di
//     arrivo (si ordina per ts, poi per id come tie-break stabile).
//   * IDEMPOTENTE: rigiocare la stessa mossa (stesso uid o stesso effetto) non
//     cambia il risultato → due dispositivi che scrivono insieme convergono.
// `team` nel log è SEMPRE un nome-squadra condiviso, mai MY_TEAM.
// ---------------------------------------------------------------------------
export function reduceMoves(moves) {
  // accetta sia un oggetto Firebase { pushId: move } sia un array [{id?, ...}]
  const events = Array.isArray(moves)
    ? moves.map((m, i) => ({ id: m.id ?? m.uid ?? String(i), ...m }))
    : Object.entries(moves || {}).map(([id, m]) => ({ id, ...(m || {}) }));

  // de-dup per uid: preferisci la copia col ts numerico (confermata dal server)
  const byUid = new Map();
  for (const e of events) {
    if (!e || !e.uid) { byUid.set(Symbol(), e); continue; } // senza uid: tienila comunque
    const prev = byUid.get(e.uid);
    if (!prev) { byUid.set(e.uid, e); continue; }
    const prevTs = typeof prev.ts === "number" ? prev.ts : -1;
    const curTs = typeof e.ts === "number" ? e.ts : -1;
    if (curTs >= prevTs) byUid.set(e.uid, e);
  }
  const uniq = [...byUid.values()].filter(Boolean);

  // ordina per (ts, id): ts non numerici (mosse locali non ancora confermate)
  // vanno in coda, così un'eco confermata dal server prevale sull'ottimistica.
  uniq.sort((a, b) => {
    const ta = typeof a.ts === "number" ? a.ts : Infinity;
    const tb = typeof b.ts === "number" ? b.ts : Infinity;
    if (ta !== tb) return ta - tb;
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  });

  const byPlayer = new Map(); // playerId -> { present, price, team, nome, ruolo, squadra }
  for (const e of uniq) {
    if (!e || !e.playerId || !e.type) continue;
    const cur = byPlayer.get(e.playerId) || { present: false };
    if (e.type === "buy") {
      byPlayer.set(e.playerId, {
        present: true,
        price: e.price,
        team: e.team,
        nome: e.nome ?? cur.nome,
        ruolo: e.ruolo ?? cur.ruolo,
        squadra: e.squadra ?? cur.squadra,
      });
    } else if (e.type === "undo") {
      byPlayer.set(e.playerId, { ...cur, present: false });
    } else if (e.type === "move") {
      byPlayer.set(e.playerId, {
        ...cur,
        present: cur.present !== false, // un move implica che è preso
        team: e.team,
        price: e.price != null ? e.price : cur.price,
        nome: e.nome ?? cur.nome,
        ruolo: e.ruolo ?? cur.ruolo,
        squadra: e.squadra ?? cur.squadra,
      });
    }
  }

  const purchases = [];
  for (const [playerId, v] of byPlayer) {
    if (!v.present) continue;
    purchases.push({
      playerId,
      price: Math.max(1, Math.round(v.price || 1)),
      team: v.team,
      nome: v.nome,
      ruolo: v.ruolo,
      squadra: v.squadra,
    });
  }
  return purchases;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sum = (arr) => arr.reduce((a, b) => a + b, 0);

export function leagueTotals(config = DEFAULT_CONFIG) {
  const totalBudget = config.numTeams * config.budgetPerTeam;
  const slotsByRole = {};
  for (const r of ROLES) slotsByRole[r] = config.numTeams * config.roster[r];
  const totalSlots = sum(ROLES.map((r) => slotsByRole[r]));
  return { totalBudget, slotsByRole, totalSlots };
}

// ---------------------------------------------------------------------------
// Stato dell'asta derivato dagli acquisti.
//   purchases: [{ playerId, price, team }]  (team === MY_TEAM per i miei acquisti)
// ---------------------------------------------------------------------------
export function computeState(players, purchases, config = DEFAULT_CONFIG) {
  const byId = new Map(players.map((p) => [p.id, p]));
  const taken = new Map(); // playerId -> { price, team }
  const spentByRole = { P: 0, D: 0, C: 0, A: 0 };
  const filledByRole = { P: 0, D: 0, C: 0, A: 0 };

  // ogni squadra parte con budget pieno e roster vuoto
  const teams = new Map();
  const ensureTeam = (id) => {
    if (!teams.has(id)) {
      teams.set(id, {
        id,
        spent: 0,
        count: 0,
        filledByRole: { P: 0, D: 0, C: 0, A: 0 },
      });
    }
    return teams.get(id);
  };
  ensureTeam(MY_TEAM);

  for (const pu of purchases) {
    const pl = byId.get(pu.playerId);
    // se il giocatore non è più nel listone (aggiornato), uso il ruolo salvato nell'acquisto
    const ruolo = pl ? pl.ruolo : pu.ruolo;
    if (!ruolo || !ROLES.includes(ruolo)) continue;
    const price = Math.max(1, Math.round(pu.price || 1));
    taken.set(pu.playerId, { price, team: pu.team });
    spentByRole[ruolo] += price;
    filledByRole[ruolo] += 1;
    const t = ensureTeam(pu.team);
    t.spent += price;
    t.count += 1;
    t.filledByRole[ruolo] += 1;
  }

  // arricchisci ogni squadra con budget e slot residui
  const teamSummaries = [];
  for (const t of teams.values()) {
    const budgetLeft = config.budgetPerTeam - t.spent;
    const slotsRemaining = {};
    let slotsRemainingTotal = 0;
    for (const r of ROLES) {
      const rem = Math.max(0, config.roster[r] - t.filledByRole[r]);
      slotsRemaining[r] = rem;
      slotsRemainingTotal += rem;
    }
    teamSummaries.push({
      id: t.id,
      isMe: t.id === MY_TEAM,
      spent: t.spent,
      budgetLeft,
      count: t.count,
      slotsRemaining,
      slotsRemainingTotal,
      // credito massimo teorico su un singolo giocatore lasciando 1 per ogni altro slot
      maxBid: Math.max(0, budgetLeft - Math.max(0, slotsRemainingTotal - 1)),
    });
  }

  const spentTotal = sum(ROLES.map((r) => spentByRole[r]));
  return {
    byId,
    taken,
    spentByRole,
    filledByRole,
    spentTotal,
    teams: teamSummaries,
    me: teamSummaries.find((t) => t.isMe),
  };
}

// ---------------------------------------------------------------------------
// Pool di crediti ancora destinato a ciascun ruolo.
// target_R = totalBudget * split_R ; residuo_R = max(0, target_R - spesoNelRuolo).
// Poi rinormalizzo così che la somma dei residui = crediti totali ancora liberi.
// ---------------------------------------------------------------------------
export function remainingPoolByRole(state, config = DEFAULT_CONFIG) {
  // Modello di DOMANDA: i crediti ancora destinati a un ruolo sono la somma,
  // su tutte le squadre, del loro budget residuo distribuito sui ruoli che
  // devono ancora riempire. Peso di un ruolo per una squadra:
  //   budgetSplit[r] * (slot di r ancora liberi / slot totali di r)
  // Così il prezzo cala se gli altri hanno già riempito quel ruolo o hanno
  // pochi crediti; all'inizio coincide con la ripartizione impostata.
  const pool = { P: 0, D: 0, C: 0, A: 0 };
  const addTeam = (budgetLeft, slotsRemaining) => {
    if (budgetLeft <= 0) return;
    const w = {};
    let wsum = 0;
    for (const r of ROLES) {
      w[r] = config.budgetSplit[r] * (slotsRemaining[r] / (config.roster[r] || 1));
      wsum += w[r];
    }
    if (wsum <= 0) return; // squadra con rosa completa: budget fuori dal mercato
    for (const r of ROLES) pool[r] += budgetLeft * (w[r] / wsum);
  };
  // squadre che hanno già comprato (budget/slot aggiornati)
  for (const t of state.teams) addTeam(t.budgetLeft, t.slotsRemaining);
  // squadre non ancora "viste" (nessun acquisto): budget pieno, rosa piena
  const emptyTeams = Math.max(0, config.numTeams - state.teams.length);
  for (let i = 0; i < emptyTeams; i++) addTeam(config.budgetPerTeam, config.roster);
  return pool;
}

// ---------------------------------------------------------------------------
// Prezzi consigliati "di mercato" (indipendenti da chi sono io) per tutti i
// giocatori disponibili, ruolo per ruolo.
// Ritorna Map playerId -> prezzo intero >= 1.
// ---------------------------------------------------------------------------
export function marketPrices(players, state, config = DEFAULT_CONFIG) {
  const { slotsByRole } = leagueTotals(config);
  const pool = remainingPoolByRole(state, config);
  const prices = new Map();

  for (const r of ROLES) {
    const avail = players
      .filter((p) => p.ruolo === r && !state.taken.has(p.id))
      .sort((a, b) => b.valoreBase - a.valoreBase);

    const slotsLeft = Math.max(0, slotsByRole[r] - state.filledByRole[r]);
    // i giocatori che verranno realmente comprati = i top `slotsLeft` per valore
    const starters = avail.slice(0, slotsLeft);
    const fillers = avail.slice(slotsLeft);

    // 1 credito di riserva per ogni slot da riempire; il resto è "discrezionale"
    const discretionary = Math.max(0, pool[r] - slotsLeft);
    const weights = starters.map((p) => Math.pow(Math.max(0, p.valoreBase), config.concentration));
    const wSum = sum(weights);

    starters.forEach((p, i) => {
      const share = wSum > 0 ? weights[i] / wSum : 1 / Math.max(1, starters.length);
      const price = 1 + discretionary * share;
      prices.set(p.id, Math.max(1, Math.round(price)));
    });
    // i "filler" (oltre gli slot disponibili nel ruolo) valgono il minimo
    fillers.forEach((p) => prices.set(p.id, 1));
  }
  return prices;
}

// ---------------------------------------------------------------------------
// Fasce (tier) per ruolo, in base al valore: Top / Semi-top / Scommessa / Low.
// ---------------------------------------------------------------------------
export function assignTiers(players) {
  const tiers = new Map();
  for (const r of ROLES) {
    const inRole = players.filter((p) => p.ruolo === r).sort((a, b) => b.valoreBase - a.valoreBase);
    const n = inRole.length || 1;
    inRole.forEach((p, i) => {
      const q = i / n; // 0 = migliore
      let tier;
      if (q < 0.1) tier = "Top";
      else if (q < 0.3) tier = "Semi-top";
      else if (q < 0.6) tier = "Scommessa";
      else tier = "Low-cost";
      tiers.set(p.id, tier);
    });
  }
  return tiers;
}

// ---------------------------------------------------------------------------
// computeBoard — la funzione che l'app chiama a ogni acquisto.
// Ritorna: { players: [...arricchiti], teams: [...], state, pools }
// Campi aggiunti a ogni giocatore:
//   taken, takenBy, takenPrice, prezzoConsigliato, prezzoMax, target, semaforo, tier
// ---------------------------------------------------------------------------
export function computeBoard(players, purchases, config = DEFAULT_CONFIG) {
  const state = computeState(players, purchases, config);
  const market = marketPrices(players, state, config);
  const tiers = assignTiers(players);
  const me = state.me;

  const enriched = players.map((p) => {
    const takenInfo = state.taken.get(p.id);
    const consigliato = market.get(p.id) ?? 1;
    const prezzoMax = Math.max(consigliato, Math.round(consigliato * (1 + config.strappo)));

    // --- raccomandazione personale ---
    const needRole = me ? me.slotsRemaining[p.ruolo] > 0 : true;
    const maxBid = me ? me.maxBid : Infinity;
    // target = quanto puntare io: consigliato, ma non oltre ciò che posso permettermi
    const target = needRole ? Math.min(consigliato, maxBid) : 0;

    let semaforo; // "verde" | "giallo" | "rosso"
    const tier = tiers.get(p.id);
    if (takenInfo) semaforo = "preso";
    else if (!needRole) semaforo = "rosso"; // ruolo già completo per me
    else if (consigliato > maxBid) semaforo = "rosso"; // non me lo posso permettere
    else if ((tier === "Top" || tier === "Semi-top") && consigliato <= maxBid * 0.6)
      semaforo = "verde"; // buon giocatore ampiamente alla mia portata → occasione
    else semaforo = "giallo";

    return {
      ...p,
      tier,
      taken: !!takenInfo,
      takenBy: takenInfo ? takenInfo.team : null,
      takenPrice: takenInfo ? takenInfo.price : null,
      prezzoConsigliato: consigliato,
      prezzoMax,
      target,
      needRole,
      semaforo,
    };
  });

  return {
    players: enriched,
    teams: state.teams,
    me,
    state,
    pools: remainingPoolByRole(state, config),
  };
}
