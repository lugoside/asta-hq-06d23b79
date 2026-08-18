"""build_players.py — costruisce docs/data/players.json (+ players.meta.json).

Flusso:
  1. carica i dati grezzi del listone se presenti (pipeline/raw/listone.json,
     prodotto da fetch_sources.py); altrimenti genera un dataset DEMO realistico
     così l'app è comunque usabile.
  2. calcola il valore base di ogni giocatore (valuation.py), ricalibrando
     QI_SCALE sui dati reali.
  3. scrive docs/data/players.json e players.meta.json.

Uso:  python build_players.py            # usa raw se c'è, altrimenti demo
      python build_players.py --demo     # forza il dataset demo
"""
from __future__ import annotations
import json
import os
import re
import sys
import random
import statistics
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw", "listone.json")
OUT_DIR = os.path.join(HERE, "..", "docs", "data")
OUT_PLAYERS = os.path.join(OUT_DIR, "players.json")
OUT_META = os.path.join(OUT_DIR, "players.meta.json")

sys.path.insert(0, HERE)
import valuation  # noqa: E402
from valuation import valuta_lista, valuta_lista_mercato, valore_da_qi, QI_REPLACEMENT  # noqa: E402

# --- squadre Serie A (placeholder; il listone reale le sovrascrive) ---------
SQUADRE_DEMO = [
    "Atalanta", "Bologna", "Cagliari", "Como", "Cremonese", "Fiorentina",
    "Genoa", "Inter", "Juventus", "Lazio", "Lecce", "Milan", "Napoli",
    "Parma", "Pisa", "Roma", "Sassuolo", "Torino", "Udinese", "Verona",
]

RUOLI_PER_SQUADRA = {"P": 3, "D": 9, "C": 9, "A": 6}  # ~27 giocatori/squadra


def genera_demo(seed: int = 42) -> list[dict]:
    """Genera un listone DEMO plausibile (nomi generici, statistiche realistiche)."""
    rnd = random.Random(seed)
    players = []
    pid = 0
    # forza di squadra: le prime ~7 sono "big" e hanno giocatori mediamente migliori
    for ti, sq in enumerate(SQUADRE_DEMO):
        forza = max(0.35, 1.0 - ti * 0.045 + rnd.uniform(-0.08, 0.08))
        for ruolo, n in RUOLI_PER_SQUADRA.items():
            for i in range(n):
                # i primi di ogni ruolo sono i titolari (più forti e più impiegati)
                rango = i / n  # 0 = titolare più forte
                titolare = rango < (0.55 if ruolo != "P" else 0.34)
                presenze = int(rnd.uniform(26, 37)) if titolare else int(rnd.uniform(0, 16))
                # qualità → fantamedia
                base_fm = {"P": 5.9, "D": 6.0, "C": 6.1, "A": 6.2}[ruolo]
                qual = forza * (1 - rango) + rnd.uniform(-0.15, 0.2)
                fm = round(base_fm + qual * {"P": 0.7, "D": 0.9, "C": 1.4, "A": 2.4}[ruolo], 2)
                fm = max(4.8, min(9.2, fm))
                # bonus grezzi coerenti col ruolo
                gol = 0
                assist = 0
                if ruolo == "A":
                    gol = int(max(0, rnd.gauss(qual * 16, 3))) if titolare else int(rnd.uniform(0, 3))
                    assist = int(max(0, rnd.gauss(qual * 4, 2)))
                elif ruolo == "C":
                    gol = int(max(0, rnd.gauss(qual * 6, 2))) if titolare else int(rnd.uniform(0, 2))
                    assist = int(max(0, rnd.gauss(qual * 6, 2)))
                elif ruolo == "D":
                    gol = int(max(0, rnd.gauss(qual * 2, 1)))
                    assist = int(max(0, rnd.gauss(qual * 2, 1)))
                rig = 0
                # quotazione iniziale coerente col valore atteso
                qi = max(1, int(round(
                    QI_REPLACEMENT[ruolo] + qual * {"P": 12, "D": 14, "C": 22, "A": 34}[ruolo]
                    + (presenze / 38) * 4
                )))
                pid += 1
                players.append({
                    "id": f"d{pid}",
                    "nome": f"{ruolo}{i+1} {sq}",
                    "squadra": sq,
                    "ruolo": ruolo,
                    "qi": qi,
                    "fvm": qi,
                    "stats2526": {
                        "presenze": presenze, "mv": round(fm - rnd.uniform(0, 0.3), 2),
                        "fm": fm, "gol": gol, "assist": assist,
                        "rigCalciati": rig, "rigSegnati": rig, "amm": int(rnd.uniform(0, 9)), "esp": 0,
                    },
                    "isNuovo": False,
                    "note": "",
                })
        # un rigorista per squadra tra i migliori A/C titolari
        cand = [p for p in players if p["squadra"] == sq and p["ruolo"] in ("A", "C")]
        cand.sort(key=lambda p: -p["qi"])
        if cand:
            r = int(rnd.uniform(5, 8))
            cand[0]["stats2526"]["rigCalciati"] = r
            cand[0]["stats2526"]["rigSegnati"] = int(r * 0.82)
    return players


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip().upper()


def annota_infortunati(players: list[dict]) -> int:
    """Marca i giocatori infortunati leggendo raw/infortunati.json (match squadra+nome)."""
    path = os.path.join(HERE, "raw", "infortunati.json")
    if not os.path.exists(path):
        return 0
    with open(path, encoding="utf-8") as f:
        inf = json.load(f)
    by_full = {(_norm(p["squadra"]), _norm(p["nome"])): p for p in players}
    n = 0
    for it in inf:
        p = by_full.get((_norm(it["squadra"]), _norm(it["nome"])))
        if not p:  # fallback: stessa squadra + stesso cognome (primo token)
            sur = _norm(it["nome"]).split(" ")[0]
            cand = [pl for pl in players if _norm(pl["squadra"]) == _norm(it["squadra"]) and _norm(pl["nome"]).split(" ")[0] == sur]
            p = cand[0] if len(cand) == 1 else None
        if p:
            p["infortunato"] = True
            p["rientro"] = it.get("rientro", "")
            p["motivoInfortunio"] = it.get("motivo", "")
            n += 1
    return n


def carica_raw() -> list[dict] | None:
    if os.path.exists(RAW):
        with open(RAW, encoding="utf-8") as f:
            return json.load(f)
    return None


def ricalibra_qi_scale(players: list[dict]) -> float:
    """Allinea il valore-da-Qi alla scala del valore-da-statistiche.

    Prende i giocatori con storico affidabile, calcola la mediana del loro
    valoreBase e la mediana del loro valore-da-Qi grezzo (a QI_SCALE=1), poi
    imposta QI_SCALE = rapporto tra le due. Così i nuovi/senza storico entrano
    nella stessa scala del resto del listone.
    """
    affidabili = [p for p in players if (p.get("stats2526", {}) or {}).get("presenze", 0) >= 15]
    if len(affidabili) < 20:
        return valuation.QI_SCALE
    val_stats = statistics.median([p["valoreBase"] for p in affidabili if p["valoreBase"] > 0] or [1])
    # valore-da-Qi grezzo a scala 1
    orig = valuation.QI_SCALE
    valuation.QI_SCALE = 1.0
    val_qi = statistics.median([
        max(0.01, valore_da_qi(p["qi"], p["ruolo"])) for p in affidabili
    ])
    valuation.QI_SCALE = orig
    scale = max(0.5, min(6.0, val_stats / val_qi)) if val_qi > 0 else orig
    return round(scale, 3)


def main():
    demo = "--demo" in sys.argv
    raw = None if demo else carica_raw()
    is_reale = raw is not None
    if is_reale:
        players = raw
        fonte = "fantacalcio-online.com — listone ufficiale 2026/27"
    else:
        players = genera_demo()
        fonte = "DEMO generato (dati non reali) — sostituire con il listone ufficiale"

    # dati reali: hanno kapitals/overall (niente storico) → modello di mercato
    dati_mercato = is_reale and any(p.get("overall") is not None for p in players)
    if dati_mercato:
        valuta_lista_mercato(players)
        nuova_scala = valuation.QI_SCALE  # non usato in modalità mercato
    else:
        # 1) prima valutazione con QI_SCALE di default
        valuta_lista(players)
        # 2) ricalibra QI_SCALE sui dati e rivaluta
        nuova_scala = ricalibra_qi_scale(players)
        valuation.QI_SCALE = nuova_scala
        valuta_lista(players)

    # aggancia gli infortuni (solo dati reali) PRIMA di scrivere il file
    n_infortunati = annota_infortunati(players) if is_reale else 0

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT_PLAYERS, "w", encoding="utf-8") as f:
        json.dump(players, f, ensure_ascii=False, separators=(",", ":"))

    # data di aggiornamento dichiarata dalla fonte (sidecar dello scraper)
    fonte_aggiornata = None
    sm = os.path.join(HERE, "raw", "source_meta.json")
    if is_reale and os.path.exists(sm):
        with open(sm, encoding="utf-8") as f:
            fonte_aggiornata = json.load(f).get("fonteAggiornata")

    per_ruolo = {r: sum(1 for p in players if p["ruolo"] == r) for r in ("P", "D", "C", "A")}
    meta = {
        "aggiornato": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "fonteAggiornata": fonte_aggiornata,
        "fonte": fonte,
        "isDemo": raw is None,
        "numGiocatori": len(players),
        "numInfortunati": n_infortunati,
        "perRuolo": per_ruolo,
        "qiScaleCalibrato": nuova_scala,
        "stagione": "2026/27",
    }
    with open(OUT_META, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print(f"Scritti {len(players)} giocatori -> {OUT_PLAYERS}")
    print(f"Per ruolo: {per_ruolo}")
    print(f"QI_SCALE calibrato: {nuova_scala}")
    print(f"Fonte: {fonte}")
    # top 5 per ruolo come sanity check
    for r in ("P", "D", "C", "A"):
        top = sorted([p for p in players if p["ruolo"] == r], key=lambda p: -p["valoreBase"])[:5]
        print(f"  Top {r}: " + ", ".join(f"{p['nome']}({p['valoreBase']})" for p in top))


if __name__ == "__main__":
    main()
