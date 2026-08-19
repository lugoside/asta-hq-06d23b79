// Test del reducer del log di mosse (modello di sync condiviso multi-writer).
// Esegui con:  node tests/test_moves.mjs
import { reduceMoves } from "../docs/engine.js";

// ---- mini framework ----
let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) passed++; else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg}\n      atteso ${JSON.stringify(b)}\n      ottenuto ${JSON.stringify(a)}`); }
// stato confrontabile a prescindere dall'ordine: mappa playerId -> {team, price}
function state(purchases) {
  const m = {};
  for (const p of purchases) m[p.playerId] = { team: p.team, price: p.price };
  return m;
}

// helper per costruire mosse come le manda Firebase: oggetto { pushId: move }
let _n = 0;
function M(list) { const o = {}; for (const mv of list) o["push" + (_n++)] = mv; return o; }

console.log("test_moves.mjs\n");

// 1) buy → presente
{
  const p = reduceMoves(M([{ uid: "a", type: "buy", playerId: "x1", team: "IO", price: 10, ts: 1 }]));
  eq(state(p), { x1: { team: "IO", price: 10 } }, "1) un buy rende il giocatore preso");
}

// 2) buy poi undo → assente
{
  const p = reduceMoves(M([
    { uid: "a", type: "buy", playerId: "x1", team: "IO", price: 10, ts: 1 },
    { uid: "b", type: "undo", playerId: "x1", ts: 2 },
  ]));
  eq(p, [], "2) buy + undo (ts crescente) → nessun acquisto");
}

// 3) buy poi move → cambia squadra, resta preso, prezzo conservato
{
  const p = reduceMoves(M([
    { uid: "a", type: "buy", playerId: "x1", team: "IO", price: 10, ts: 1 },
    { uid: "b", type: "move", playerId: "x1", team: "Marco", ts: 2 },
  ]));
  eq(state(p), { x1: { team: "Marco", price: 10 } }, "3) move sposta squadra e mantiene il prezzo");
}

// 4) DETERMINISMO: lo stesso insieme di mosse in ordine di array diverso → stesso stato
{
  const moves = [
    { uid: "a", type: "buy", playerId: "x1", team: "IO", price: 10, ts: 3 },
    { uid: "b", type: "buy", playerId: "x2", team: "Marco", price: 5, ts: 1 },
    { uid: "c", type: "move", playerId: "x1", team: "Lucia", ts: 5 },
    { uid: "d", type: "undo", playerId: "x2", ts: 7 },
  ];
  const A = state(reduceMoves(M(moves)));
  const B = state(reduceMoves(M([...moves].reverse())));
  eq(A, B, "4) l'ordine di arrivo non cambia il risultato (ordina per ts)");
  eq(A, { x1: { team: "Lucia", price: 10 } }, "4b) risultato atteso dopo la riduzione");
}

// 5) IDEMPOTENZA: rigiocare la stessa mossa (stesso effetto, uid diverso) non cambia lo stato
{
  const once = reduceMoves(M([{ uid: "a", type: "buy", playerId: "x1", team: "IO", price: 10, ts: 1 }]));
  const twice = reduceMoves(M([
    { uid: "a", type: "buy", playerId: "x1", team: "IO", price: 10, ts: 1 },
    { uid: "a2", type: "buy", playerId: "x1", team: "IO", price: 10, ts: 1 },
  ]));
  eq(state(once), state(twice), "5) buy ripetuto è idempotente sullo stato");
}

// 6) DE-DUP per uid: copia ottimistica (ts non numerico) + eco del server (ts numerico) → una sola,
//    e prevale quella del server.
{
  const p = reduceMoves(M([
    { uid: "a", type: "buy", playerId: "x1", team: "IO", price: 10, ts: "local" }, // ottimistica
    { uid: "a", type: "buy", playerId: "x1", team: "IO", price: 10, ts: 1000 },     // eco server
  ]));
  eq(state(p), { x1: { team: "IO", price: 10 } }, "6) de-dup per uid: una sola voce");
}

// 7) ORDINAMENTO per ts: chi ha ts maggiore vince sullo stesso giocatore
{
  // undo (ts 5) dopo buy (ts 2): assente. In ordine array invertito, stesso esito.
  const a = reduceMoves(M([
    { uid: "u", type: "undo", playerId: "x1", ts: 5 },
    { uid: "b", type: "buy", playerId: "x1", team: "IO", price: 10, ts: 2 },
  ]));
  eq(a, [], "7) undo con ts maggiore vince sul buy precedente");
  // buy (ts 9) dopo undo (ts 5): presente
  const b = reduceMoves(M([
    { uid: "u", type: "undo", playerId: "x1", ts: 5 },
    { uid: "b", type: "buy", playerId: "x1", team: "IO", price: 7, ts: 9 },
  ]));
  eq(state(b), { x1: { team: "IO", price: 7 } }, "7b) ri-acquisto con ts maggiore torna preso");
}

// 8) OTTIMISTICA = più recente: una mossa locale non ancora confermata (ts non numerico) viene
//    ordinata DOPO le mosse confermate (ts numerico). Così "la mia ultima azione locale" prevale
//    finché non arriva l'eco del server (che la riordinerà col ts reale). Qui il buy locale su IO
//    è la mossa più recente e vince sul move server verso Marco.
{
  const p = reduceMoves(M([
    { uid: "local", type: "buy", playerId: "x1", team: "IO", price: 3, ts: "local" },
    { uid: "srv", type: "move", playerId: "x1", team: "Marco", ts: 2000 },
  ]));
  eq(state(p), { x1: { team: "IO", price: 3 } }, "8) la mossa ottimistica (non confermata) è la più recente e vince");
}

// 9) MERGE MULTI-WRITER: due dispositivi comprano giocatori diversi → entrambi presenti
{
  const devA = [{ uid: "A1", type: "buy", playerId: "x1", team: "IO", price: 10, ts: 100 }];
  const devB = [{ uid: "B1", type: "buy", playerId: "x2", team: "Marco", price: 20, ts: 101 }];
  const p = reduceMoves(M([...devA, ...devB]));
  eq(state(p), { x1: { team: "IO", price: 10 }, x2: { team: "Marco", price: 20 } },
    "9) acquisti concorrenti su giocatori diversi convivono (nessuna sovrascrittura)");
}

// 10) CONFLITTO stesso giocatore da due writer: vince il ts maggiore
{
  const p = reduceMoves(M([
    { uid: "A1", type: "buy", playerId: "x1", team: "IO", price: 10, ts: 100 },
    { uid: "B1", type: "buy", playerId: "x1", team: "Marco", price: 12, ts: 105 },
  ]));
  eq(state(p), { x1: { team: "Marco", price: 12 } }, "10) doppio buy sullo stesso giocatore: vince il ts maggiore");
}

// 11) prezzo arrotondato e >= 1
{
  const p = reduceMoves(M([{ uid: "a", type: "buy", playerId: "x1", team: "IO", price: 0, ts: 1 }]));
  eq(p[0].price, 1, "11) prezzo minimo 1");
}

// 12) accetta anche un array di mosse (con id/uid) oltre all'oggetto Firebase
{
  const p = reduceMoves([
    { uid: "a", type: "buy", playerId: "x1", team: "IO", price: 4, ts: 1 },
    { uid: "b", type: "buy", playerId: "x2", team: "IO", price: 6, ts: 2 },
  ]);
  eq(state(p), { x1: { team: "IO", price: 4 }, x2: { team: "IO", price: 6 } }, "12) input come array");
}

// 13) input vuoto / nullo
{
  eq(reduceMoves(null), [], "13) null → []");
  eq(reduceMoves({}), [], "13b) oggetto vuoto → []");
  eq(reduceMoves([]), [], "13c) array vuoto → []");
}

console.log(`\n${passed} passati, ${failed} falliti`);
process.exit(failed ? 1 : 0);
