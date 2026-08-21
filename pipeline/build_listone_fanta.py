#!/usr/bin/env python3
"""
build_listone_fanta.py — RIFONDA il listone sulla lista ufficiale fantacalcio.it.

La lista .xlsx di fantacalcio.it (Lista calciatori / Svincolati) e' la fonte
AUTOREVOLE dei giocatori acquistabili + id nativo (#) + QUOT. + FVM/1000.
Il nostro vecchio listone (fantacalcio-online) porta pero' i NOMI COMPLETI e il
rating `overall`, che servono alla UI e all'aggancio delle fonti extra
(infortuni/formazioni/rigoristi). Quindi:

  roster autorevole = fanta.it (528)  +  nome completo/overall da fco (match)

Per i giocatori gia' presenti da noi: teniamo l'`id` fco (stabile, non rompe lo
stato) e sovrascriviamo qi/fvm con QUOT./FVM ufficiali. Per i "nuovi" (presenti
su fanta.it ma non nel nostro listone, es. Lukaku, Angelino): id = "f<fantaId>",
nome/ruolo dalla lista fanta. In OGNI record viene scritto `fantaId` = id del
sito -> l'import CSV non ha piu' bisogno di un crosswalk esterno.

Scrive raw/listone.json (rifondato). Poi lanciare build_players.py per rigenerare
docs/data/players.json (valutazione di mercato + enrichment).

Uso:
  python build_listone_fanta.py <lista_fantacalcio.xlsx> [raw/listone.json] [-o raw/listone.json]
Richiede: openpyxl
"""
import json, os, argparse, unicodedata, re, html
import openpyxl
import build_crosswalk as B  # riusa norm() e match()

def _fanta_record(fid, nome_raw, sq_raw, ruolo, mantra, fvm, quot, qa=None):
    """Costruisce un record 'fanta' con i campi per il match (sur/ini/surc)."""
    f = {"id": fid, "nome_raw": ihtml_unescape(str(nome_raw)), "sq_raw": sq_raw,
         "ruolo": str(ruolo), "mantra": mantra or "", "fvm": fvm, "quot": quot, "qa": qa if qa is not None else quot,
         "nome": str(nome_raw), "sq": B.norm(sq_raw)}
    toks = B.norm(f["nome"]).split()
    if toks and len(toks[-1]) == 1:
        f["ini"], f["sur"] = toks[-1], " ".join(toks[:-1])
    else:
        f["ini"], f["sur"] = "", " ".join(toks)
    f["surc"] = f["sur"].replace(" ", "")
    return f


def ihtml_unescape(s):
    return html.unescape(s)


def load_fanta_json(path):
    """Carica la lista scrapata da fetch_quotazioni.py (raw/quotazioni_fanta.json).
    Record attesi: {id, nome, squadra, ruolo, qi, fvm}. Nessun 'fuori lista' qui."""
    data = json.load(open(path, encoding="utf-8"))
    return [_fanta_record(str(p["id"]), p["nome"], p["squadra"], p["ruolo"], p.get("ruoloMantra", ""),
                          p.get("fvm", 1), p.get("qi", 1), p.get("qa", p.get("qi", 1))) for p in data]


def load_fanta_full(xlsx):
    """Come B.load_fanta ma conserva anche la squadra/ruoloMantra in casing originale.
    ESCLUDE i giocatori 'Fuori lista' (colonna con '*'): trasferiti all'estero /
    non acquistabili — non devono entrare nel listone."""
    ws = openpyxl.load_workbook(xlsx, read_only=True, data_only=True).active
    out, n_fuori = [], 0
    for r in list(ws.iter_rows(values_only=True))[1:]:
        if not r[0]:
            continue
        if r[2] not in (None, "", 0):  # 'Fuori lista' = '*'  -> non acquistabile
            n_fuori += 1
            continue
        f = {"id": r[0], "nome_raw": html.unescape(str(r[1])), "sq_raw": r[3],
             "ruolo": str(r[5]), "mantra": r[6] or "",
             "fvm": r[10] or 1, "quot": r[11] or 1, "qa": r[11] or 1,
             "nome": str(r[1]), "sq": B.norm(r[3])}
        toks = B.norm(f["nome"]).split()
        if toks and len(toks[-1]) == 1:
            f["ini"], f["sur"] = toks[-1], " ".join(toks[:-1])
        else:
            f["ini"], f["sur"] = "", " ".join(toks)
        f["surc"] = f["sur"].replace(" ", "")
        out.append(f)
    if n_fuori:
        print(f"Esclusi {n_fuori} giocatori 'Fuori lista' (*) non acquistabili.")
    return out

def main():
    HERE = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument("fonte", nargs="?", default=os.path.join(HERE, "raw", "quotazioni_fanta.json"),
                    help="lista ufficiale fantacalcio.it: .json (scrape di fetch_quotazioni.py, DEFAULT) o .xlsx (export di lega)")
    ap.add_argument("old", nargs="?", default=os.path.join(HERE, "raw", "listone.json"),
                    help="listone fantacalcio-online per recuperare nomi completi+overall (default: raw/listone.json)")
    ap.add_argument("-o", "--out", default=os.path.join(HERE, "listone_base.json"),
                    help="output versionato (default: pipeline/listone_base.json)")
    args = ap.parse_args()

    fanta = load_fanta_json(args.fonte) if args.fonte.lower().endswith(".json") else load_fanta_full(args.fonte)
    old = json.load(open(args.old, encoding="utf-8"))

    # match: per ogni giocatore VECCHIO trova la miglior riga fanta (top score);
    # costruisce fantaId -> record vecchio (in caso di collisione tiene lo score piu' alto).
    best = {}  # fantaId -> (score, old_record)
    for o in old:
        c = B.match(o, fanta)
        if not c:
            continue
        score, f = c[0]
        fid = f["id"]
        if fid not in best or score > best[fid][0]:
            best[fid] = (score, o)

    claimed = {fid: rec for fid, (sc, rec) in best.items()}
    listone, n_match, n_new = [], 0, 0
    for f in fanta:
        fid = f["id"]
        if fid in claimed:
            o = dict(claimed[fid])  # copia del record vecchio (nome completo, overall, ecc.)
            o["qi"] = f["quot"]           # quotazione INIZIALE ufficiale fanta.it
            o["qa"] = f["qa"]             # quotazione ATTUALE ufficiale fanta.it
            o["fvm"] = f["fvm"]           # FVM UFFICIALE
            o["ruolo"] = f["ruolo"]       # RUOLO autorevole di lega (fanta.it), non il nostro
            o["ruoloMantra"] = f["mantra"]
            o["fantaId"] = fid
            listone.append(o); n_match += 1
        else:
            listone.append({
                "id": f"f{fid}", "nome": f["nome_raw"], "squadra": f["sq_raw"],
                "ruolo": f["ruolo"], "ruoloMantra": f["mantra"],
                "qi": f["quot"], "qa": f["qa"], "fvm": f["fvm"], "overall": None,
                "bonusAtteso": 0.0, "lineupRating": None, "isNuovo": True,
                "stats2526": {}, "note": "", "fantaId": fid,
            })
            n_new += 1

    json.dump(listone, open(args.out, "w", encoding="utf-8"), ensure_ascii=False)
    dropped = len(old) - n_match
    print(f"Listone fanta: {len(fanta)}  ->  scritti {len(listone)} record in {args.out}")
    print(f"  agganciati al nostro listone (nome completo+overall): {n_match}")
    print(f"  nuovi (solo su fanta.it, nome abbreviato): {n_new}")
    print(f"  scartati (nostri, non piu' acquistabili su fanta.it): {dropped}")
    if n_new:
        print("\n  Nuovi entrati nel listone:")
        for p in listone:
            if p["isNuovo"] and p["id"].startswith("f") and not p["id"].startswith("fco"):
                print(f'    [{p["fantaId"]}] {p["nome"]} ({p["squadra"]}, {p["ruolo"]})  QUOT {p["qi"]}  FVM {p["fvm"]}')

if __name__ == "__main__":
    main()
