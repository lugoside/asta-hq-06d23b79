// build_lite.mjs — genera i dati RIDOTTI per l'app LITE (versione avversari).
// Tiene SOLO i campi pubblici/non-vantaggiosi; toglie tutto ciò che dà vantaggio
// (valoreBase, overall, bonusAtteso, titolarità, fmProiettata, fvm, lineupRating,
//  stats, note, fonteValore, presenzeAttese…). Così, anche aprendo il sorgente
// della LITE, gli avversari non vedono i dati elaborati della versione piena.
//
// Uso (dalla root del repo FULL):  node pipeline/build_lite.mjs
// Output di default nel repo LITE affiancato:  ../Fantacalcio-lite/docs/data/
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const SRC = "docs/data";
const OUT = process.env.LITE_OUT || "../Fantacalcio-lite/docs/data";
// qi = quotazione iniziale UFFICIALE di fantacalcio.it (dato PUBBLICO, non un vantaggio); niente valoreBase/tier/fvm
const KEEP = ["id", "nome", "squadra", "ruolo", "isNuovo", "qi", "qa"];

const players = JSON.parse(readFileSync(`${SRC}/players.json`, "utf8"));
const lite = players.map((p) => {
  const o = {};
  for (const k of KEEP) if (p[k] !== undefined) o[k] = p[k];
  return o;
});

let meta = {};
try { meta = JSON.parse(readFileSync(`${SRC}/players.meta.json`, "utf8")); } catch {}
const metaLite = {
  stagione: meta.stagione,
  aggiornato: meta.aggiornato,
  fonteAggiornata: meta.fonteAggiornata,
  numGiocatori: lite.length,
  isDemo: !!meta.isDemo,
};

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/players_lite.json`, JSON.stringify(lite));
writeFileSync(`${OUT}/players_lite.meta.json`, JSON.stringify(metaLite, null, 2));
console.log(`LITE: ${lite.length} giocatori → ${OUT}/players_lite.json (campi tenuti: ${KEEP.join(", ")})`);
