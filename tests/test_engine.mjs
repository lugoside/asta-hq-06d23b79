// Test del motore di prezzo. Esegui con:  node tests/test_engine.mjs
import {
  DEFAULT_CONFIG,
  ROLES,
  MY_TEAM,
  leagueTotals,
  computeBoard,
  marketPrices,
  computeState,
  remainingPoolByRole,
} from "../docs/engine.js";

// ---- mini framework di asserzioni ----
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error("  ✗ FAIL:", msg);
  }
}
function almost(a, b, tol, msg) {
  ok(Math.abs(a - b) <= tol, `${msg} (atteso ~${b}, ottenuto ${a}, tol ${tol})`);
}

// ---- dati sintetici deterministici ----
// per ogni ruolo genero N giocatori con valoreBase decrescente e regolare.
function makePlayers() {
  const counts = { P: 30, D: 90, C: 95, A: 70 }; // più giocatori che slot (realistico)
  const players = [];
  let id = 0;
  for (const r of ROLES) {
    const n = counts[r];
    for (let i = 0; i < n; i++) {
      // valore da ~100 (top) a ~1 (ultimo), curva un po' ripida
      const v = Math.round(100 * Math.pow(1 - i / n, 2)) + 1;
      players.push({ id: `${r}${i}`, nome: `${r}-${i}`, squadra: `T${i % 20}`, ruolo: r, valoreBase: v });
      id++;
    }
  }
  return players;
}

const players = makePlayers();
const cfg = DEFAULT_CONFIG;
const { totalBudget, slotsByRole } = leagueTotals(cfg);

console.log("== Test 1: totali lega ==");
ok(totalBudget === 5000, "budget totale = 5000");
ok(slotsByRole.P === 30 && slotsByRole.D === 80 && slotsByRole.C === 80 && slotsByRole.A === 60, "slot per ruolo corretti");
ok(ROLES.map((r) => slotsByRole[r]).reduce((a, b) => a + b) === 250, "slot totali = 250");

console.log("== Test 2: board iniziale (nessun acquisto) ==");
let board = computeBoard(players, [], cfg);
ok(board.players.every((p) => Number.isInteger(p.prezzoConsigliato) && p.prezzoConsigliato >= 1), "tutti i prezzi interi >= 1");
ok(board.players.every((p) => !p.taken), "nessuno preso");
ok(board.me.budgetLeft === 500 && board.me.slotsRemainingTotal === 25, "il mio budget/slot iniziali corretti");

// la somma dei prezzi consigliati sugli starters di un ruolo ~ pool del ruolo
for (const r of ROLES) {
  const pool = board.pools[r];
  const slotsLeft = slotsByRole[r];
  const starters = board.players
    .filter((p) => p.ruolo === r)
    .sort((a, b) => b.valoreBase - a.valoreBase)
    .slice(0, slotsLeft);
  const s = starters.reduce((a, p) => a + p.prezzoConsigliato, 0);
  // tolleranza: arrotondamenti + floor da 1 credito per slot
  ok(s <= pool * 1.1 + slotsLeft && s >= pool * 0.75, `ruolo ${r}: somma starters (${s}) ~ pool (${Math.round(pool)})`);
}

// il pool iniziale rispetta la ripartizione (P 8/ D 14/ C 28/ A 50 %)
almost(board.pools.A, 5000 * 0.5, 1, "pool attacco iniziale = 50% di 5000");
almost(board.pools.C, 5000 * 0.28, 1, "pool centrocampo iniziale = 28%");

console.log("== Test 3: il top attaccante costa molto più del filler ==");
const attaccanti = board.players.filter((p) => p.ruolo === "A").sort((a, b) => b.prezzoConsigliato - a.prezzoConsigliato);
ok(attaccanti[0].prezzoConsigliato > 50, `top A caro (${attaccanti[0].prezzoConsigliato})`);
ok(attaccanti[attaccanti.length - 1].prezzoConsigliato === 1, "ultimo A = 1 credito");

console.log("== Test 4: inflazione/scarsità dopo aver tolto i big ==");
// prezzo di un attaccante di media classifica PRIMA
const midA = players.filter((p) => p.ruolo === "A").sort((a, b) => b.valoreBase - a.valoreBase)[20];
const priceBefore = board.players.find((p) => p.id === midA.id).prezzoConsigliato;
// altri comprano i top 15 attaccanti a prezzo pieno
const topA = players.filter((p) => p.ruolo === "A").sort((a, b) => b.valoreBase - a.valoreBase).slice(0, 15);
const purchases = topA.map((p, i) => ({ playerId: p.id, price: 40, team: `AVV${i % 9}` }));
const board2 = computeBoard(players, purchases, cfg);
const priceAfter = board2.players.find((p) => p.id === midA.id).prezzoConsigliato;
ok(priceAfter > priceBefore, `mid-A si rivaluta dopo che i big vanno via (${priceBefore} → ${priceAfter})`);

console.log("== Test 5: stato squadre e maxBid ==");
const st = computeState(players, [{ playerId: "A0", price: 120, team: MY_TEAM }], cfg);
ok(st.me.spent === 120 && st.me.budgetLeft === 380, "spesa/budget mio aggiornati");
ok(st.me.slotsRemaining.A === 5 && st.me.slotsRemainingTotal === 24, "slot attacco/totali scalati");
// maxBid = budgetLeft - (slotsRemainingTotal - 1) = 380 - 23 = 357
ok(st.me.maxBid === 357, `maxBid corretto (${st.me.maxBid})`);

console.log("== Test 6: semaforo ==");
// riempio tutti i miei slot portiere → un altro portiere deve diventare rosso
const myP = players.filter((p) => p.ruolo === "P").slice(0, 3).map((p) => ({ playerId: p.id, price: 1, team: MY_TEAM }));
const board3 = computeBoard(players, myP, cfg);
const altroPortiere = board3.players.find((p) => p.ruolo === "P" && !p.taken);
ok(altroPortiere.semaforo === "rosso" && altroPortiere.needRole === false, "ruolo P completo → semaforo rosso");
// un giocatore preso ha semaforo "preso"
ok(board3.players.find((p) => p.taken).semaforo === "preso", "preso → semaforo preso");

console.log("== Test 7: nessuna spesa negativa, prezzi sempre validi a metà asta ==");
ok(board2.players.filter((p) => !p.taken).every((p) => p.prezzoConsigliato >= 1), "prezzi validi anche a metà asta");
ok(board2.me.maxBid >= 0, "maxBid mai negativo");

console.log(`\nRisultato: ${passed} passati, ${failed} falliti`);
process.exit(failed === 0 ? 0 : 1);
