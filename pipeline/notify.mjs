#!/usr/bin/env node
/**
 * notify.mjs — rileva NOVITÀ sui 25 giocatori della rosa e prepara un'email.
 *
 * Confronta lo stato attuale (probabili + infortuni) con lo snapshot precedente
 * (pipeline/notify_state.json) e, se c'è una novità DEGNA DI NOTA, scrive oggetto+corpo
 * dell'email e segnala send=true su $GITHUB_OUTPUT. Calcola anche l'impatto sull'11
 * consigliato (motore Formazione replicato da docs/app.js — TENERE ALLINEATO A MANO:
 * FORM_CFG, teamCtx, contextMult, bestXI devono combaciare con app.js).
 *
 * Eventi che fanno scattare l'email:
 *  - titolare ⇄ riserva (flip di status)
 *  - variazione % ≥ SOGLIA_PERC
 *  - nuovo infortunio / rientro annunciato o cambio prognosi / recupero
 *  - cambio nell'11 consigliato (entra/esce un titolare)
 *
 * Uso:  node pipeline/notify.mjs   (dalla root del repo)
 */
import fs from "fs";

const SOGLIA_PERC = 15;                 // variazione % probabili che vale una notifica
const R = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const tryR = (p, d) => { try { return R(p); } catch { return d; } };

const DATA = "docs/data", PIPE = "pipeline";
const g = tryR(`${DATA}/giornata.json`, null);
const players = tryR(`${DATA}/players.json`, []);
const qaAsta = tryR(`${DATA}/qa_asta.json`, { qa: {}, fvm: {} });
const roster = (tryR(`${PIPE}/my_roster_ids.json`, { roster: [] }).roster) || [];
const indisp = tryR(`${PIPE}/raw/indisponibili.json`, {});   // {team:[{fantaId?,nome,rientro,desc}]} o simile
const prev = tryR(`${PIPE}/notify_state.json`, { players: {}, xi: [] });

if (!g || !roster.length) { console.log("dati insufficienti, esco"); process.exit(0); }

const ROLES = ["P", "D", "C", "A"];
const pm = {}; players.forEach((p) => (pm[String(p.fantaId)] = p));

// ---- match infortuni per COGNOME + SQUADRA (indisponibili.json ha nome+squadra, non fantaId) ----
const _deac = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const surnameOf = (n) => { const t = _deac(n).replace(/[.]/g, "").split(/\s+/).filter(Boolean); return t.length > 1 ? t.slice(0, -1).join(" ") : (t[0] || ""); };
const injList = Array.isArray(indisp) ? indisp : (indisp && typeof indisp === "object" ? Object.values(indisp).flat() : []);
const injuryFor = (p) => { const sn = surnameOf(p.nome), sq = _deac(p.squadra); return injList.find((x) => _deac(x.squadra) === sq && surnameOf(x.nome) === sn) || null; };

// =================== MOTORE (replica di docs/app.js — allineare a mano) ===================
const FORM_CFG = {
  goalThresholds: [66, 72, 77, 81, 85, 89, 93, 97, 101],
  defMod: { includeKeeper: true, minDef: 4, bands: [[6, 1], [6.25, 2], [6.5, 3], [6.75, 4.5], [7, 6]] },
  sub: { base: 6.0, bonusW: 0.5 },
  factors: {
    enabled: true, clamp: 0.15, formWindow: 3, rampGiornate: 8,
    A: { offOpp: 0.09, offOwn: 0.09, oppStrength: 0.05, form: 0.08 },
    C: { offOpp: 0.08, offOwn: 0.08, oppStrength: 0.05, form: 0.08 },
    D: { defOwn: 0.08, defOpp: 0.08, offOpp: 0.03, offOwn: 0.02, oppStrength: 0.05, form: 0.07 },
    P: { defOwn: 0.10, defOpp: 0.10, oppStrength: 0.05, form: 0.06, penSave: 0 },
  },
};
const MODULI = { "3-4-3": [3, 4, 3], "3-5-2": [3, 5, 2], "4-3-3": [4, 3, 3], "4-4-2": [4, 4, 2], "4-5-1": [4, 5, 1], "5-3-2": [5, 3, 2], "5-4-1": [5, 4, 1] };
const COVER_MARGIN = 0.75;
const pPlay = (st, prob, inj) => inj ? 0 : !prob ? 0.15 : prob.status === "titolare" ? (prob.perc ?? 70) / 100 : (prob.perc ?? 0) / 100;
function fvIfPlays(st, prob, inj) {
  if (inj) return 0;
  const base = (st && st.pg > 0 && st.mfv) ? st.mfv : 6.0;
  if (!prob || prob.status === "titolare") return base;
  const bonusRate = (st && st.pg > 0 && st.mfv && st.mv) ? Math.max(0, st.mfv - st.mv) : 0;
  return FORM_CFG.sub.base + FORM_CFG.sub.bonusW * bonusRate;
}
function ptsRankMap() {
  if (g._ptsRank) return g._ptsRank;
  const cl = g.classifica || {}, map = {};
  for (const t in cl) { const p = cl[t].pts; if (p == null) { map[t] = cl[t].rank || null; continue; } let a = 0; for (const u in cl) if ((cl[u].pts || 0) > p) a++; map[t] = a + 1; }
  return (g._ptsRank = map);
}
function leagueAvg() {
  if (g._lg) return g._lg;
  const ts = g.teamStats || {}; let hGF = 0, hGP = 0, aGF = 0, aGP = 0;
  for (const t in ts) { const s = ts[t]; hGF += s.homeGF; hGP += s.homeGP; aGF += s.awayGF; aGP += s.awayGP; }
  return (g._lg = { home: hGP ? hGF / hGP : 1.4, away: aGP ? aGF / aGP : 1.4 });
}
function teamCtx(p) {
  const tm = g.teamMatch ? g.teamMatch[p.squadra] : null;
  if (!tm) return null;
  const cl = g.classifica || {}, ts = g.teamStats || {};
  const own = ts[p.squadra] || {}, opp = ts[tm.opponent] || {};
  const home = !!tm.home;
  const rV = (gpV, vV, s, key) => { if (gpV) return +(vV / gpV).toFixed(2); const gpAll = (s.homeGP || 0) + (s.awayGP || 0); return gpAll ? +(((s["home" + key] || 0) + (s["away" + key] || 0)) / gpAll).toFixed(2) : null; };
  const rk = ptsRankMap();
  return {
    venue: home ? "home" : "away", opp: tm.opponent, oppRank: rk[tm.opponent] || null, ownRank: rk[p.squadra] || null,
    ownGApg: home ? rV(own.homeGP, own.homeGA, own, "GA") : rV(own.awayGP, own.awayGA, own, "GA"),
    oppGFpg: home ? rV(opp.awayGP, opp.awayGF, opp, "GF") : rV(opp.homeGP, opp.homeGF, opp, "GF"),
    oppGApg: home ? rV(opp.awayGP, opp.awayGA, opp, "GA") : rV(opp.homeGP, opp.homeGA, opp, "GA"),
    ownGFpg: home ? rV(own.homeGP, own.homeGF, own, "GF") : rV(own.awayGP, own.awayGF, own, "GF"),
  };
}
function contextMult(p) {
  const F = FORM_CFG.factors; if (!F.enabled) return 1;
  const w = F[p.ruolo], c = p._ctx; if (!w || !c) return 1;
  const lg = leagueAvg();
  const refScore = c.venue === "home" ? lg.home : lg.away, refConc = c.venue === "home" ? lg.away : lg.home;
  const cl = (x) => Math.max(-1, Math.min(1, x));
  const ramp = Math.min(1, (g.lastFullGiornata || 0) / (F.rampGiornate || 8));
  let m = 1; const add = (d) => { const dd = d * ramp; if (dd) m *= 1 + dd; };
  if (w.offOpp && c.oppGApg != null && refScore) add(w.offOpp * cl(c.oppGApg / refScore - 1));
  if (w.offOwn && c.ownGFpg != null && refScore) add(w.offOwn * cl(c.ownGFpg / refScore - 1));
  if (w.defOwn && c.ownGApg != null && refConc) add(-w.defOwn * cl(c.ownGApg / refConc - 1));
  if (w.defOpp && c.oppGFpg != null && refConc) add(-w.defOpp * cl(c.oppGFpg / refConc - 1));
  if (w.oppStrength && c.oppRank) add(w.oppStrength * ((c.oppRank - 10.5) / 9.5));
  if (w.form) { const dt = g.detail ? g.detail[String(p.fantaId ?? p.id)] : null; if (dt && dt.fmSeq && dt.fmSeq.length && dt.fm) { const seq = dt.fmSeq.slice(-(F.formWindow || 4)); add(w.form * cl(seq.reduce((a, b) => a + b, 0) / seq.length / dt.fm - 1)); } }
  const k = F.clamp || 0.15; return Math.max(1 - k, Math.min(1 + k, m));
}
const expVoto = (p) => (p._st && p._st.pg > 0 && p._st.mv) ? p._st.mv : 6.0;
function defenseModifier(defVotes, keeperVote) {
  const c = FORM_CFG.defMod; if (defVotes.length < c.minDef) return 0;
  const s = defVotes.slice().sort((a, b) => b - a);
  const pool = c.includeKeeper && keeperVote != null ? [...s.slice(0, 3), keeperVote] : s.slice(0, 4);
  const avg = pool.reduce((a, b) => a + b, 0) / pool.length; let bonus = 0; for (const [th, b] of c.bands) if (avg >= th) bonus = b; return bonus;
}
const goalsFromScore = (t) => { let n = 0; for (const x of FORM_CFG.goalThresholds) { if (t >= x) n++; else break; } return n; };
function kComb(n, k) { const r = [], c = []; const go = (s) => { if (c.length === k) { r.push(c.slice()); return; } for (let i = s; i < n; i++) { c.push(i); go(i + 1); c.pop(); } }; go(0); return r; }
function slotValue(st, bench) { const risky = st.slice().sort((a, b) => a._pPlay - b._pPlay); let v = 0; risky.forEach((s, k) => { const c = bench[k]; v += s._pPlay * s._fv + (1 - s._pPlay) * (c ? c._exp : 0); }); return v; }
function bestRole(pool, n) {
  if (pool.length <= n) return { starters: pool.slice(), value: pool.reduce((s, x) => s + x._pPlay * x._fv, 0) };
  const byExp = pool.slice().sort((a, b) => b._exp - a._exp);
  const set0 = byExp.slice(0, n), v0 = slotValue(set0, byExp.slice(n));
  let best = { starters: set0, value: v0 };
  for (const combo of kComb(pool.length, n)) { const ch = new Set(combo); const st = combo.map((i) => pool[i]); const bench = pool.filter((_, i) => !ch.has(i)).sort((a, b) => b._exp - a._exp); const v = slotValue(st, bench); if (v > best.value) best = { starters: st, value: v }; }
  return (best.value - v0 >= COVER_MARGIN) ? best : { starters: set0, value: v0 };
}
function bestXI(list) {
  const byRole = { P: [], D: [], C: [], A: [] }; list.forEach((p) => byRole[p.ruolo] && byRole[p.ruolo].push(p));
  const cache = {}, sel = (r, n) => cache[r + n] || (cache[r + n] = bestRole(byRole[r] || [], n));
  let best = null;
  for (const [mod, [nd, nc, na]] of Object.entries(MODULI)) {
    if (byRole.P.length < 1 || byRole.D.length < nd || byRole.C.length < nc || byRole.A.length < na) continue;
    const need = { P: 1, D: nd, C: nc, A: na }; const xi = [], defs = []; let total = 0;
    for (const r of ROLES) { const s = sel(r, need[r]); total += s.value; xi.push(...s.starters); if (r === "D") defs.push(...s.starters); }
    total += defenseModifier(defs.map(expVoto), expVoto(sel("P", 1).starters[0]));
    if (!best || total > best.total) best = { mod, xi, total, goals: goalsFromScore(total) };
  }
  return best;
}
// ==========================================================================================

// arricchisci la rosa (probabili + infortunio + resa)
const rin = (g.rinvii && g.giornataCorrente != null) ? new Set(g.rinvii[String(g.giornataCorrente)] || []) : new Set();
roster.forEach((p) => {
  const k = String(p.fantaId);
  p._st = (g.stats || {})[k] || null;
  p._prob = (g.probabili || {})[k] || null;
  const inj = injuryFor(p);
  p._injured = !!inj; p._rientro = inj ? (inj.rientro || "") : "";
  p._ctx = teamCtx(p);
  p._pPlay = pPlay(p._st, p._prob, p._injured);
  p._fvBase = fvIfPlays(p._st, p._prob, p._injured);
  p._fv = p._fvBase * contextMult(p);
  p._exp = p._pPlay * p._fv;
});
const xi = bestXI(roster);
const xiIds = xi ? xi.xi.map((p) => String(p.fantaId)) : [];

// stato attuale (solo i campi su cui confrontiamo → snapshot stabile)
const curPlayers = {};
roster.forEach((p) => {
  const pr = p._prob || {};
  curPlayers[String(p.fantaId)] = { status: pr.status || null, perc: pr.perc ?? null, injured: p._injured, rientro: p._rientro || "" };
});

// ---- calcola gli EVENTI (novità) ----
const nome = (p) => { const t = String(p.nome || "").trim().split(/\s+/); return t.length > 1 ? t.slice(0, -1).join(" ") : (p.nome || ""); };
const byFid = {}; roster.forEach((p) => byFid[String(p.fantaId)] = p);
const eventi = [];
for (const p of roster) {
  const k = String(p.fantaId), a = curPlayers[k], b = prev.players[k] || {};
  // probabili: flip di status o variazione % rilevante
  if (a.status !== (b.status ?? null)) {
    const em = a.status === "titolare" ? "🟢" : a.status === "riserva" ? "⚪" : "◽";
    eventi.push(`${em} ${nome(p)} (${p.ruolo}): ${b.status || "assente"} ${b.perc ?? ""}${b.perc != null ? "%" : ""} → ${a.status || "assente"} ${a.perc ?? ""}${a.perc != null ? "%" : ""}`.replace(/\s+/g, " ").trim());
  } else if (a.perc != null && b.perc != null && Math.abs(a.perc - b.perc) >= SOGLIA_PERC) {
    eventi.push(`${a.perc > b.perc ? "📈" : "📉"} ${nome(p)} (${p.ruolo}): ${a.status} ${b.perc}% → ${a.perc}%`);
  }
  // infortuni / prognosi
  if (a.injured && !b.injured) eventi.push(`🩹 ${nome(p)} (${p.ruolo}): NUOVO INFORTUNIO${a.rientro ? ` · rientro previsto ${a.rientro}` : " · prognosi non ancora nota"}`);
  else if (!a.injured && b.injured) eventi.push(`💪 ${nome(p)} (${p.ruolo}): RECUPERATO (non più tra gli indisponibili)`);
  else if (a.injured && b.injured && a.rientro !== (b.rientro || "")) eventi.push(`📅 ${nome(p)} (${p.ruolo}): prognosi aggiornata → rientro ${a.rientro || "non definito"}`);
}
// cambio 11 consigliato (entra/esce)
const prevXi = new Set(prev.xi || []);
const curXi = new Set(xiIds);
if (prev.xi && prev.xi.length) {
  const usciti = [...prevXi].filter((k) => !curXi.has(k)).map((k) => byFid[k] ? nome(byFid[k]) : k);
  const entrati = [...curXi].filter((k) => !prevXi.has(k)).map((k) => byFid[k] ? nome(byFid[k]) : k);
  if (usciti.length || entrati.length) eventi.push(`🔀 11 consigliato: esce ${usciti.join(", ") || "—"} · entra ${entrati.join(", ") || "—"}`);
}

const send = eventi.length > 0 && (prev.xi && prev.xi.length || Object.keys(prev.players).length); // no email al primissimo giro (solo bootstrap dello stato)

// ---- corpo email ----
const line = (r) => xi ? xi.xi.filter((p) => p.ruolo === r).map((p) => nome(p)).join(", ") : "";
const dataAgg = g.aggiornato ? new Date(g.aggiornato).toLocaleString("it-IT", { timeZone: "Europe/Rome" }) : "";
const body = [
  `Novità sulla tua rosa (giornata ${g.giornataCorrente ?? "?"}) — dati del ${dataAgg}`,
  ``,
  `── COSA È CAMBIATO ──`,
  ...eventi.map((e) => ` ${e}`),
  ``,
  `── 11 CONSIGLIATO ORA (modulo ${xi ? xi.mod : "?"}, punteggio ${xi ? xi.total.toFixed(1) : "?"}) ──`,
  ...ROLES.map((r) => ` ${r}: ${line(r)}`).filter((s) => s.trim().length > 3),
  ``,
  `— FantaAsta · notifica automatica —`,
].join("\n");
const subject = `⚽ FantaAsta: ${eventi.length} novità sulla rosa (g.${g.giornataCorrente ?? "?"})`;

// scrivi lo stato nuovo (sempre, così i prossimi diff sono corretti)
fs.writeFileSync(`${PIPE}/notify_state.json`, JSON.stringify({ players: curPlayers, xi: xiIds, aggiornato: g.aggiornato }, null, 0));
fs.writeFileSync(`${PIPE}/notify_subject.txt`, subject);
fs.writeFileSync(`${PIPE}/notify_body.txt`, body);

console.log(send ? `INVIO: ${eventi.length} eventi\n${body}` : `nessun evento da notificare (eventi: ${eventi.length}, bootstrap: ${!(prev.xi && prev.xi.length)})`);
const out = process.env.GITHUB_OUTPUT;
if (out) fs.appendFileSync(out, `send=${send ? "true" : "false"}\nsubject=${subject.replace(/\n/g, " ")}\n`);
