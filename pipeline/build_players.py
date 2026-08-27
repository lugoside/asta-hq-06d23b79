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
import difflib
import hashlib
import json
import os
import re
import sys
import random
import statistics
import unicodedata
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
# listone BASE rifondato su fanta.it (versionato, prodotto da build_listone_fanta.py):
# ha la precedenza sul grezzo scaricato da fantacalcio-online (raw/, gitignored).
LISTONE_BASE = os.path.join(HERE, "listone_base.json")
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
    """Marca gli infortunati UNENDO due fonti: raw/infortunati.json (fantacalcio-online,
    con data di rientro strutturata) + raw/indisponibili.json (fantacalcio.it, copertura
    più ampia ma spesso senza data). Se un giocatore compare in entrambe, si preferisce la
    data di rientro non vuota. Match per (squadra, nome), fallback su (squadra, cognome)."""
    entries = []
    for fname in ("infortunati.json", "indisponibili.json"):  # ordine: prima la fonte con le date
        path = os.path.join(HERE, "raw", fname)
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                entries += json.load(f)
    if not entries:
        return 0
    by_full = {(_norm(p["squadra"]), _norm(p["nome"])): p for p in players}
    marcati = set()
    for it in entries:
        p = by_full.get((_norm(it["squadra"]), _norm(it["nome"])))
        if not p:  # fallback: stessa squadra + stesso cognome (primo token)
            sur = _norm(it["nome"]).split(" ")[0]
            cand = [pl for pl in players if _norm(pl["squadra"]) == _norm(it["squadra"]) and _norm(pl["nome"]).split(" ")[0] == sur]
            p = cand[0] if len(cand) == 1 else None
        if not p:
            continue
        p["infortunato"] = True
        # non sovrascrivere una data già presente con una vuota (unione delle fonti)
        if it.get("rientro") and not p.get("rientro"):
            p["rientro"] = it["rientro"]
        elif "rientro" not in p:
            p["rientro"] = it.get("rientro", "")
        if it.get("motivo") and not p.get("motivoInfortunio"):
            p["motivoInfortunio"] = it["motivo"]
        marcati.add(p["id"])
    return len(marcati)


def fattore_infortunio(p: dict, oggi, fvm_peak: float = 0.0) -> float:
    """Malus infortunio (strategia B, anti doppio-conteggio con l'FVM). 1.0 = nessun malus.
    - non infortunato / rientro passato → 1.0
    - infortunio CORTO (rientro entro INFORTUNIO_GIORNI_CORTO) → 1.0 (non vale la pena;
      l'FVM basta). Anche i casi senza data (default) cadono qui.
    - infortunio LUNGO → malus parabolico SOLO se l'FVM NON è già sceso per l'infortunio:
      se il calo dell'FVM dal picco recente (fvm_peak) è >= INFORTUNIO_CALO_FVM il mercato
      l'ha già prezzato → 1.0; altrimenti applica la parabola (esp INFORTUNIO_ESP)."""
    if not p.get("infortunato"):
        return 1.0
    from datetime import date
    d = None
    m = re.search(r"(\d{1,2})/(\d{1,2})(?:/(\d{4}))?", p.get("rientro") or "")
    if m:
        gg, mm = int(m.group(1)), int(m.group(2))
        yy = int(m.group(3)) if m.group(3) else oggi.year
        try:
            d = (date(yy, mm, gg) - oggi).days
            if d < -180 and not m.group(3):
                d = (date(yy + 1, mm, gg) - oggi).days
        except ValueError:
            d = None
    if d is None:
        d = INFORTUNIO_GIORNI_DEFAULT
    if d <= INFORTUNIO_GIORNI_CORTO:      # rientro passato o infortunio corto → nessun malus
        return 1.0
    # LUNGO: se l'FVM è già calato dal picco recente, il mercato ha già prezzato lo stop
    cur = float(p.get("fvm", 0) or 0)
    if fvm_peak > 0 and cur > 0 and (fvm_peak - cur) / fvm_peak >= INFORTUNIO_CALO_FVM:
        return 1.0
    frac = min(d, INFORTUNIO_GIORNI_PIENO) / INFORTUNIO_GIORNI_PIENO
    return round(1.0 - FATTORE_INFORTUNIO_MAX * (frac ** INFORTUNIO_ESP), 3)


FVM_HISTORY = os.path.join(HERE, "fvm_history.json")
FVM_HISTORY_GIORNI = 21  # finestra dello storico FVM per il picco pre-infortunio


def aggiorna_fvm_history(players: list[dict], oggi) -> dict:
    """Aggiorna pipeline/fvm_history.json con l'FVM di oggi per fantaId, pota oltre
    FVM_HISTORY_GIORNI giorni, e ritorna {fantaId: picco FVM nella finestra}."""
    from datetime import date
    hist = {}
    if os.path.exists(FVM_HISTORY):
        try:
            hist = json.load(open(FVM_HISTORY, encoding="utf-8"))
        except Exception:
            hist = {}
    today = oggi.isoformat()
    for p in players:
        fid = str(p.get("fantaId") or "")
        fv = p.get("fvm")
        if fid and fv is not None:
            hist.setdefault(fid, {})[today] = fv
    # pota le date vecchie
    def _old(dstr):
        try:
            y, mo, dd = map(int, dstr.split("-"))
            return (oggi - date(y, mo, dd)).days > FVM_HISTORY_GIORNI
        except Exception:
            return True
    for fid in list(hist.keys()):
        hist[fid] = {dd: v for dd, v in hist[fid].items() if not _old(dd)}
        if not hist[fid]:
            del hist[fid]
    with open(FVM_HISTORY, "w", encoding="utf-8") as f:
        json.dump(hist, f, ensure_ascii=False)
    return {fid: max(v.values()) for fid, v in hist.items() if v}


def _deacc(s: str) -> str:
    """Maiuscolo senza accenti, spazi normalizzati (per il match dei nomi)."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", s).strip().upper()


# titolarità associata allo stato-formazione
TIT_FORMAZIONE = {"titolare": 0.9, "ballottaggio": 0.6, "riserva": 0.35}
RANK_STATUS = {"titolare": 3, "ballottaggio": 2, "riserva": 1}
# quanto lo stato-formazione incide sul valore (e quindi sul prezzo consigliato)
FATTORE_FORMAZIONE = {"titolare": 1.0, "ballottaggio": 0.9, "riserva": 0.7}
# corroborazione morbida: SOSFanta dice "ballottaggio" ma fantacalcio.it lo dà titolare
# → penalità ammorbidita (tra titolare 1.0 e ballottaggio 0.9). Vedi formazioni_fanta.json.
FATTORE_FORMAZIONE_CORROBORATO = 0.95
FORMAZIONI_FANTA = os.path.join(HERE, "formazioni_fanta.json")
# boost per il rigorista designato (rank 1 = titolare dei rigori) e per i battitori di punizione
# rigore (gol, alta frequenza) > punizione (gol, rara) > corner (assist)
FATTORE_RIGORISTA = {1: 1.10, 2: 1.05, 3: 1.02, 4: 1.01}
FATTORE_PUNIZIONE = {1: 1.04, 2: 1.02, 3: 1.01}
FATTORE_CORNER = {1: 1.02, 2: 1.02, 3: 1.01, 4: 1.01, 5: 1.01}
# malus INFORTUNIO proporzionale ai giorni al rientro, PARABOLICO (non lineare):
# malus = MAX * (min(giorni, PIENO)/PIENO)^2 ; il valore è moltiplicato per (1 - malus).
# Basso fino a ~1 mese (~2.5%), ripido dopo, 90% a ~6 mesi. Rientro passato → nessun malus.
FATTORE_INFORTUNIO_MAX = 0.90    # malus massimo (stop >= ~6 mesi)
INFORTUNIO_GIORNI_PIENO = 180    # giorni di stop a cui si raggiunge il malus massimo
INFORTUNIO_ESP = 1.75            # esponente della parabola (1=lineare, 2=parabola piena)
INFORTUNIO_GIORNI_DEFAULT = 30   # infortunato ma SENZA data di rientro nota → cade nei "corti" (no malus)
INFORTUNIO_GIORNI_CORTO = 45     # rientro entro questi giorni = infortunio corto → nessun malus
INFORTUNIO_CALO_FVM = 0.08       # se l'FVM è già sceso >= 8% dal picco → mercato ha prezzato → no malus
# opinione esperta goal.com (guida asta a fasce) → riconciliazione con l'FVM.
# Tocca SOLO le divergenze: declass dove il modello gonfia e goal.com dissente,
# lieve spinta dove l'app sottovaluta un endorsement. Vedi pipeline/goal_tiers.json.
GOAL_TIERS = os.path.join(HERE, "goal_tiers.json")
GOAL_DECLASS = 0.94      # -6%: app alto ma goal.com "scommesse" (o att. 3ª con ≥2 bonus impilati)
GOAL_BOOST = 1.04        # +4%: goal.com 1ª/2ª ma app Scommessa/Low, o goal Top & app Semi
GOAL_BOOST_MOD = 1.03    # +3%: difensore "da modificatore" sepolto dall'app (Low)
GOAL_TOKEN = 1.01        # +1% simbolico: difensore endorsed ma già alto (evita doppio conteggio)
GOAL_BONUS_EXTRA = 1.02  # extra sub-additivo: difensore spinto su che è ANCHE fonte-bonus


def annota_formazioni(players: list[dict]) -> int:
    """Marca titolare/ballottaggio/riserva leggendo raw/formazioni.json (DAZN).
    Match per (squadra, cognome): il nome DAZN è il cognome, il nome nel listone
    inizia col cognome. In caso di più candidati prende quello con Qi più alto.
    """
    path = os.path.join(HERE, "raw", "formazioni.json")
    if not os.path.exists(path):
        return 0
    with open(path, encoding="utf-8") as f:
        form = json.load(f)
    # indice per squadra
    by_team = {}
    for p in players:
        by_team.setdefault(_deacc(p["squadra"]), []).append(p)
    n = 0
    for it in form:
        team = _deacc(it["squadra"])
        name = _deacc(it["nome"])
        if not name:
            continue
        # tutte le parole del nome DAZN devono essere presenti nel nome completo del
        # giocatore (in qualsiasi ordine): gestisce "Lautaro Martínez" vs "Martinez Lautaro"
        tokens = [t for t in name.split(" ") if t]
        cands = [p for p in by_team.get(team, []) if set(tokens) <= set(_deacc(p["nome"]).split(" "))]
        if not cands:
            continue
        p = max(cands, key=lambda x: x.get("qi", 0))
        st = it["status"]
        # non declassare: se già titolare non lo rendo riserva per una cella successiva
        if RANK_STATUS[st] > RANK_STATUS.get(p.get("formazione", ""), 0):
            if "formazione" not in p:
                n += 1
            p["formazione"] = st
            p["titolarita"] = TIT_FORMAZIONE[st]
    return n


def _annota_specialisti(players: list[dict], filename: str, field: str, tipo_map=None) -> None:
    """Marca specialisti (rigoristi/punizioni/corner) leggendo raw/<filename>,
    match per (squadra, token del nome). `field` è il campo di default; se le voci
    hanno 'tipo', usa tipo_map per scegliere il campo. Tiene il rank migliore."""
    path = os.path.join(HERE, "raw", filename)
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        items = json.load(f)
    by_team = {}
    for p in players:
        by_team.setdefault(_deacc(p["squadra"]), []).append(p)
    for it in items:
        tokens = [t for t in _deacc(it["nome"]).split(" ") if t]
        if not tokens:
            continue
        cands = [p for p in by_team.get(_deacc(it["squadra"]), []) if set(tokens) <= set(_deacc(p["nome"]).split(" "))]
        if not cands:
            continue
        p = max(cands, key=lambda x: x.get("qi", 0))
        f = tipo_map.get(it.get("tipo"), field) if tipo_map else field
        if f not in p or it["rank"] < p[f]:
            p[f] = it["rank"]


def annota_rigoristi(players: list[dict]) -> None:
    # rigoristi.json contiene voci tipo rigore|punizione (Gazzetta)
    _annota_specialisti(players, "rigoristi.json", "rigoreRank",
                        tipo_map={"rigore": "rigoreRank", "punizione": "punizioneRank"})
    # corner.json (SOSFanta)
    _annota_specialisti(players, "corner.json", "cornerRank")


def _gtok(s: str) -> list[str]:
    """Token del nome per il match goal.com: deaccentato, senza punteggiatura,
    scarta le iniziali puntate (es. 'P.' → ignorato)."""
    return [t for t in re.sub(r"[^A-Z0-9]", " ", _deacc(s)).split() if len(t) > 1]


def _match_in_pool(pool: list[dict], nm: str):
    """Trova il giocatore in `pool` (stessa squadra) che corrisponde al nome-fonte `nm`,
    robusto ai refusi: 1) sottoinsieme di token esatto; 2) forma compatta senza spazi
    ('Del Prato'<->'Delprato'); 3) fuzzy difflib + 'stesse lettere' per le trasposizioni
    ('Schimd'<->'Schmid'). Ritorna il giocatore o None."""
    gt = _gtok(nm)
    if not gt:
        return None
    cands = [p for p in pool if set(gt) <= set(_gtok(p["nome"]))]
    if cands:
        return max(cands, key=lambda x: x.get("qi", 0))
    gc = "".join(gt)
    if len(gc) >= 5:
        comp = [p for p in pool if gc in "".join(_gtok(p["nome"]))]
        if comp:
            return max(comp, key=lambda x: x.get("qi", 0))
    main = max(gt, key=len)
    best_p, best_s = None, 0.0
    for p in pool:
        for t in _gtok(p["nome"]):
            s = difflib.SequenceMatcher(None, main, t).ratio()
            if len(main) >= 5 and len(t) >= 5 and sorted(main) == sorted(t):
                s = max(s, 0.95)
            if s > best_s:
                best_p, best_s = p, s
    return best_p if best_s >= 0.86 else None


def _candidates(pool: list[dict], nm: str) -> list[dict]:
    """Tutti i giocatori del pool che matchano il nome-fonte (per la disambiguazione omonimi)."""
    gt = _gtok(nm)
    if not gt:
        return []
    exact = [p for p in pool if set(gt) <= set(_gtok(p["nome"]))]
    if exact:
        return exact
    gc = "".join(gt)
    if len(gc) >= 5:
        comp = [p for p in pool if gc in "".join(_gtok(p["nome"]))]
        if comp:
            return comp
    m = _match_in_pool(pool, nm)
    return [m] if m else []


def _assign(pool: list[dict], names: list[str]) -> dict:
    """Assegna una LISTA di nomi-fonte ai giocatori, senza doppioni: risolve prima i
    nomi con meno candidati liberi (match unici), poi gli ambigui ai rimasti.
    Es. XI Inter 'Lautaro' + 'Martinez' → Lautaro Martinez e Josep Martinez, non due volte Lautaro."""
    cand = {nm: _candidates(pool, nm) for nm in dict.fromkeys(names)}
    claimed, res = set(), {}
    pend = [nm for nm in cand if cand[nm]]
    while pend:
        pend.sort(key=lambda nm: len([p for p in cand[nm] if id(p) not in claimed]))
        nm = pend.pop(0)
        free = [p for p in cand[nm] if id(p) not in claimed]
        if not free:
            continue
        pl = max(free, key=lambda x: x.get("qi", 0))
        claimed.add(id(pl))
        res[nm] = pl
    return res


# CONSENSO formazioni a 3 fonti (SOSFanta + fanta.it + goal.com):
GOAL_FORMAZIONI = os.path.join(HERE, "goal_formazioni.json")
FATTORE_CONSENSO_TIT = {3: 1.00, 2: 0.95, 1: 0.90}  # titolare in 3/2/1 fonti
FATTORE_CONSENSO_BALL = 0.80   # mai titolare, ballottaggio in >=1 fonte
FATTORE_CONSENSO_RIS = 0.70    # non compare in nessuna lista di nessuna fonte


def annota_formazioni_consenso(players: list[dict]) -> dict:
    """Combina 3 fonti formazioni e assegna a OGNI giocatore un moltiplicatore:
      - titolare in N fonti → 3:x1.00 / 2:x0.95 / 1:x0.90
      - mai titolare ma ballottaggio in >=1 fonte → x0.80
      - assente da tutte → x0.70 (riserva)
    Fonti: SOSFanta (raw/formazioni.json, status), fanta.it (formazioni_fanta.json,
    titolari+ballottaggi), goal.com (goal_formazioni.json, titolari+ballottaggi).
    Setta p['formFactor'], p['formazione'] (label) e p['formVotes'] (trasparenza)."""
    by_team: dict[str, list[dict]] = {}
    for p in players:
        by_team.setdefault(_deacc(p["squadra"]), []).append(p)

    # per ogni fonte: dict team-deacc -> {"tit":[nomi], "ball":[nomi]}
    def _from_teamdict(path):
        out = {}
        if not os.path.exists(path):
            return out
        data = json.load(open(path, encoding="utf-8")).get("formazioni", {})
        for team, info in data.items():
            out[_deacc(team)] = {"tit": info.get("titolari", []), "ball": info.get("ballottaggi", [])}
        return out

    src = {}
    src["fanta"] = _from_teamdict(FORMAZIONI_FANTA)
    src["goal"] = _from_teamdict(GOAL_FORMAZIONI)
    # SOSFanta: lista piatta di record {squadra,nome,status}
    sos = {}
    spath = os.path.join(HERE, "raw", "formazioni.json")
    if os.path.exists(spath):
        for it in json.load(open(spath, encoding="utf-8")):
            t = _deacc(it["squadra"]); d = sos.setdefault(t, {"tit": [], "ball": []})
            d["tit" if it.get("status") == "titolare" else "ball"].append(it["nome"])
    src["sos"] = sos

    for p in players:
        p["_titSrc"], p["_ballSrc"] = set(), set()
    for key, bs in src.items():
        for team, lists in bs.items():
            pool = by_team.get(team, [])
            for pl in _assign(pool, lists["tit"]).values():   # assegnazione senza doppioni
                pl["_titSrc"].add(key)
            for pl in _assign(pool, lists["ball"]).values():
                pl["_ballSrc"].add(key)

    cnt = {"tit": 0, "ball": 0, "ris": 0}
    for p in players:
        tn, bn = len(p["_titSrc"]), len(p["_ballSrc"])
        if tn >= 1:
            p["formFactor"] = FATTORE_CONSENSO_TIT[min(tn, 3)]
            p["formazione"] = "titolare"; cnt["tit"] += 1
        elif bn >= 1:
            p["formFactor"] = FATTORE_CONSENSO_BALL
            p["formazione"] = "ballottaggio"; cnt["ball"] += 1
        else:
            p["formFactor"] = FATTORE_CONSENSO_RIS
            p["formazione"] = "riserva"; cnt["ris"] += 1
        p["formVotes"] = {"tit": tn, "ball": bn}
        p["titolarita"] = TIT_FORMAZIONE.get(p["formazione"], 0.6)
        del p["_titSrc"], p["_ballSrc"]
    return cnt


def annota_goal(players: list[dict]) -> int:
    """Marca ogni giocatore con la fascia goal.com (`goalBand` 1..4) leggendo
    goal_tiers.json. Match per token del nome DENTRO il ruolo (goal.com non dà la
    squadra; il ruolo disambigua es. Martinez P vs A). Vince la banda migliore."""
    if not os.path.exists(GOAL_TIERS):
        return 0
    with open(GOAL_TIERS, encoding="utf-8") as f:
        data = json.load(f)
    by_role: dict[str, list[dict]] = {}
    for p in players:
        by_role.setdefault(p["ruolo"], []).append(p)
    n = 0
    for ruolo, bands in data.items():
        if ruolo.startswith("_"):
            continue
        pool = by_role.get(ruolo, [])
        for band in ("1", "2", "3", "4"):
            for name in bands.get(band, []):
                gt = _gtok(name)
                if not gt:
                    continue
                cands = [p for p in pool if set(gt) <= set(_gtok(p["nome"]))]
                if not cands:
                    continue
                p = max(cands, key=lambda x: x.get("qi", 0))
                if "goalBand" not in p:  # la prima (migliore) banda che matcha vince
                    p["goalBand"] = int(band)
                    n += 1
    return n


def annota_formazioni_fanta(players: list[dict]) -> dict:
    """Da fantacalcio.it (formazioni_fanta.json), stessa fonte delle quotazioni:
    - `fantaTitolare=True` per l'XI-tipo (corroborazione morbida del ballottaggio);
    - rigoreRank / punizioneRank dalle liste ordinate → PRIMARIE (override Gazzetta),
      chiamata DOPO annota_rigoristi così fanta.it vince dove presente e la Gazzetta
      resta a coprire i buchi. I CORNER restano da SOSFanta (qui non ci sono).
    Match per (squadra, token del nome) DENTRO la squadra."""
    res = {"tit": 0, "rig": 0, "pun": 0}
    if not os.path.exists(FORMAZIONI_FANTA):
        return res
    data = json.load(open(FORMAZIONI_FANTA, encoding="utf-8")).get("formazioni", {})
    by_team: dict[str, list[dict]] = {}
    for p in players:
        by_team.setdefault(_deacc(p["squadra"]), []).append(p)

    def _find(pool, nm):
        gt = _gtok(nm)
        if not gt:
            return None
        # 1) match esatto per sottoinsieme di token
        cands = [p for p in pool if set(gt) <= set(_gtok(p["nome"]))]
        if cands:
            return max(cands, key=lambda x: x.get("qi", 0))
        # 1b) match COMPATTO (senza spazi): copre le varianti di spaziatura
        #     ("Delprato" <-> "Del Prato", "Kolo Muani" <-> "Kolomuani").
        gc = "".join(gt)
        if len(gc) >= 5:
            comp = [p for p in pool if gc in "".join(_gtok(p["nome"]))]
            if comp:
                return max(comp, key=lambda x: x.get("qi", 0))
        # 2) fallback FUZZY dentro la stessa squadra: tollera i refusi della fonte
        #    (es. "Schimd"->Schmid, "Saelemakers"->Saelemaekers). Soglia alta per
        #    non confondere compagni diversi.
        main = max(gt, key=len)
        best_p, best_s = None, 0.0
        for p in pool:
            for t in _gtok(p["nome"]):
                s = difflib.SequenceMatcher(None, main, t).ratio()
                # stesse lettere in ordine diverso (refuso/trasposizione, es. schimd<->schmid)
                if len(main) >= 5 and len(t) >= 5 and sorted(main) == sorted(t):
                    s = max(s, 0.95)
                if s > best_s:
                    best_p, best_s = p, s
        return best_p if best_s >= 0.86 else None

    for team, info in data.items():
        pool = by_team.get(_deacc(team), [])
        for nm in info.get("titolari", []):
            p = _find(pool, nm)
            if p and not p.get("fantaTitolare"):
                p["fantaTitolare"] = True
                res["tit"] += 1
        for i, nm in enumerate(info.get("rigoristi", [])):
            p = _find(pool, nm)
            if p:
                p["rigoreRank"] = i + 1  # override: fanta.it primaria
                res["rig"] += 1
        for i, nm in enumerate(info.get("punizioni", [])):
            p = _find(pool, nm)
            if p:
                p["punizioneRank"] = i + 1
                res["pun"] += 1
    return res


def _app_band(players: list[dict]) -> dict[int, int]:
    """Fascia quantile per ruolo su valoreBase (replica engine.assignTiers):
    1=Top(<10%) 2=Semi(<30%) 3=Scommessa(<60%) 4=Low. Chiave = id(p)."""
    band: dict[int, int] = {}
    by_role: dict[str, list[dict]] = {}
    for p in players:
        by_role.setdefault(p["ruolo"], []).append(p)
    for pool in by_role.values():
        arr = sorted(pool, key=lambda x: -x["valoreBase"])
        n = len(arr)
        for i, p in enumerate(arr):
            q = i / n if n else 0
            band[id(p)] = 1 if q < 0.1 else 2 if q < 0.3 else 3 if q < 0.6 else 4
    return band


def fattore_goal(p: dict, ab: int, gb: int) -> float:
    """Fattore moltiplicativo goal.com dato (fascia app `ab`, fascia goal `gb`).
    Agisce solo sulle divergenze; 1.0 = nessun cambiamento (default)."""
    nb = (1 if p.get("rigoreRank") else 0) + (1 if p.get("punizioneRank") else 0) + (1 if p.get("cornerRank") else 0)
    f = 1.0
    # (1) declass: il modello lo tiene alto ma goal.com dissente
    if ab <= 2 and (gb == 4 or (gb == 3 and nb >= 2 and p["ruolo"] == "A")):
        f = GOAL_DECLASS
    # (2) spinta: goal.com endorsa un giocatore che l'app sottovaluta
    elif gb <= 2 and ab >= 3:
        f = GOAL_BOOST
    elif gb == 1 and ab == 2:
        f = GOAL_BOOST
    elif p["ruolo"] == "D" and gb == 3 and ab == 4:
        f = GOAL_BOOST_MOD
    elif p["ruolo"] == "D" and ab <= 2 and gb <= 3:
        f = GOAL_TOKEN
    # (3) difensore VERAMENTE spinto (non token) che è anche fonte-bonus: extra sub-additivo
    if f > GOAL_TOKEN and p["ruolo"] == "D" and (gb == 2 or nb >= 1):
        f = round(f * GOAL_BONUS_EXTRA, 3)
    return round(f, 3)


def carica_raw() -> list[dict] | None:
    # preferisci il listone rifondato su fanta.it (versionato); fallback sul grezzo scaricato
    for path in (LISTONE_BASE, RAW):
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
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
        fonte = "fantacalcio.it — lista ufficiale 2026/27 (QUOT./FVM); nomi/rating da fantacalcio-online"
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

    # aggancia infortuni, formazioni (consenso 3 fonti) e rigoristi PRIMA di scrivere
    n_infortunati = annota_infortunati(players) if is_reale else 0
    n_cons = {"tit": 0, "ball": 0, "ris": 0}
    n_ft = {"tit": 0, "rig": 0, "pun": 0}
    if is_reale:
        annota_rigoristi(players)  # rigori + punizioni + corner (Gazzetta/SOSFanta)
        n_ft = annota_formazioni_fanta(players)  # fanta.it: rigoristi/punizioni (primari) + fantaTitolare
        n_cons = annota_formazioni_consenso(players)  # 3 fonti → formFactor + formazione (SOVRASCRIVE)
    n_formazioni = n_cons["tit"] + n_cons["ball"]
    # formazione (consenso), rigori e infortunio incidono sul valore (→ prezzo consigliato)
    oggi = datetime.now(timezone.utc).date()
    fvm_peak = aggiorna_fvm_history(players, oggi) if is_reale else {}  # picco FVM per anti doppio-conteggio
    for p in players:
        ff = p.get("formFactor", 1.0)  # consenso: 1.00/0.95/0.90 tit · 0.80 ball · 0.70 ris
        if ff != 1.0:
            p["valoreBase"] = round(p["valoreBase"] * ff, 2)
        rb = FATTORE_RIGORISTA.get(p.get("rigoreRank"))
        if rb:
            p["valoreBase"] = round(p["valoreBase"] * rb, 2)
        pb = FATTORE_PUNIZIONE.get(p.get("punizioneRank"))
        if pb:
            p["valoreBase"] = round(p["valoreBase"] * pb, 2)
        cb = FATTORE_CORNER.get(p.get("cornerRank"))
        if cb:
            p["valoreBase"] = round(p["valoreBase"] * cb, 2)
        # malus INFORTUNIO (strategia B: corti=0, lunghi solo se FVM non già sceso)
        inj = fattore_infortunio(p, oggi, fvm_peak.get(str(p.get("fantaId")), 0.0))
        p["injuryFactor"] = inj
        if inj != 1.0:
            p["valoreBase"] = round(p["valoreBase"] * inj, 2)

    # opinione esperta goal.com: applicata DOPO gli altri fattori (la fascia app è
    # calcolata sul valoreBase corrente, così confronta l'opinione del modello con
    # quella di goal.com e la corregge solo dove divergono).
    if is_reale:
        n_goal = annota_goal(players)
        ab_map = _app_band(players)
        n_goal_mossi = 0
        for p in players:
            gb = p.get("goalBand")
            if not gb:
                continue
            gf = fattore_goal(p, ab_map[id(p)], gb)
            p["goalFactor"] = gf
            if gf != 1.0:
                p["valoreBase"] = round(p["valoreBase"] * gf, 2)
                n_goal_mossi += 1
    else:
        n_goal = n_goal_mossi = 0

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT_PLAYERS, "w", encoding="utf-8") as f:
        json.dump(players, f, ensure_ascii=False, separators=(",", ":"))

    # data di aggiornamento dichiarata dalla fonte (sidecar dello scraper)
    fonte_aggiornata = None
    sm = os.path.join(HERE, "raw", "source_meta.json")
    if is_reale and os.path.exists(sm):
        with open(sm, encoding="utf-8") as f:
            fonte_aggiornata = json.load(f).get("fonteAggiornata")

    # --- monitoraggio FRESCHEZZA fonti: impronta per fonte, confrontata col run precedente ---
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    raw_dir = os.path.join(HERE, "raw")

    def _fp(fname):
        p = os.path.join(raw_dir, fname)
        return hashlib.sha1(open(p, "rb").read()).hexdigest()[:12] if os.path.exists(p) else None

    prev_sources = {}
    if os.path.exists(OUT_META):
        try:
            prev_sources = (json.load(open(OUT_META, encoding="utf-8")) or {}).get("sources", {})
        except Exception:
            prev_sources = {}

    def _status(name, fp):
        prev = prev_sources.get(name, {})
        return {"fp": fp, "lastChanged": now_iso if fp != prev.get("fp") else prev.get("lastChanged", now_iso)}

    _listone_fp = (hashlib.sha1(open(LISTONE_BASE, "rb").read()).hexdigest()[:12]
                   if os.path.exists(LISTONE_BASE) else (fonte_aggiornata or _fp("listone.json")))
    sources = {
        "Listone": _status("Listone", _listone_fp),
        "Infortuni": _status("Infortuni", _fp("infortunati.json")),
        "Formazioni": _status("Formazioni", _fp("formazioni.json")),
        "Rigori/Punizioni": _status("Rigori/Punizioni", _fp("rigoristi.json")),
        "Corner": _status("Corner", _fp("corner.json")),
    }

    per_ruolo = {r: sum(1 for p in players if p["ruolo"] == r) for r in ("P", "D", "C", "A")}
    meta = {
        "aggiornato": now_iso,
        "fonteAggiornata": fonte_aggiornata,
        "sources": sources,
        "fonte": fonte,
        "isDemo": raw is None,
        "numGiocatori": len(players),
        "numInfortunati": n_infortunati,
        "numFormazioni": n_formazioni,
        "consensoFormazioni": n_cons,
        "numRigoristi": sum(1 for p in players if p.get("rigoreRank")),
        "numPunizioni": sum(1 for p in players if p.get("punizioneRank")),
        "numCorner": sum(1 for p in players if p.get("cornerRank")),
        "numGoalTiers": n_goal,
        "numGoalMossi": n_goal_mossi,
        "numFantaTitolari": n_ft["tit"],
        "numFantaRigoristi": n_ft["rig"],
        "numFantaPunizioni": n_ft["pun"],
        "perRuolo": per_ruolo,
        "qiScaleCalibrato": nuova_scala,
        "stagione": "2026/27",
    }
    with open(OUT_META, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print(f"Scritti {len(players)} giocatori -> {OUT_PLAYERS}")
    print(f"Per ruolo: {per_ruolo}")
    print(f"QI_SCALE calibrato: {nuova_scala}")
    print(f"goal.com: {n_goal} match, {n_goal_mossi} valori corretti")
    print(f"probabili fantacalcio.it: {n_ft['rig']} rigoristi, {n_ft['pun']} punizioni (primari)")
    print(f"consenso formazioni (3 fonti): titolari {n_cons['tit']}, ballottaggi {n_cons['ball']}, riserve {n_cons['ris']}")
    print(f"Fonte: {fonte}")
    # top 5 per ruolo come sanity check
    for r in ("P", "D", "C", "A"):
        top = sorted([p for p in players if p["ruolo"] == r], key=lambda p: -p["valoreBase"])[:5]
        print(f"  Top {r}: " + ", ".join(f"{p['nome']}({p['valoreBase']})" for p in top))


if __name__ == "__main__":
    main()
