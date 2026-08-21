#!/usr/bin/env python3
"""
Costruisce il crosswalk  fco_id -> id fantacalcio.it  incrociando:
  - il nostro players.json           (id "fco####", nome "Cognome Nome", squadra, ruolo)
  - la lista calciatori di fantacalcio.it esportata in .xlsx
    (colonne: #, Nome, Fuori lista, Sq., Under, R., R.MANTRA, ...; "#" = id del sito)

Il match e' su cognome (token / prefisso / forma compatta) disambiguato da
ruolo, squadra e iniziale del nome. Verificato: De Gea=2521, Carnesecchi=4431,
Falcone=2134. Rilanciare a ridosso dell'asta con una lista aggiornata per
ridurre i "non trovati" (giocatori non ancora quotati / trasferiti).

Uso:
  python build_crosswalk.py <lista_fantacalcio.xlsx> [players.json] [-o fco_to_fanta.json]

Richiede: openpyxl  (pip install openpyxl)
"""
import json, unicodedata, re, html, sys, os, argparse
import openpyxl

def norm(s):
    s = html.unescape(str(s))
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z ]", "", s.lower()).strip()

def load_fanta(xlsx):
    ws = openpyxl.load_workbook(xlsx, read_only=True, data_only=True).active
    fanta = []
    for r in list(ws.iter_rows(values_only=True))[1:]:
        if not r[0]:
            continue
        f = {"id": r[0], "nome": str(r[1]), "sq": norm(r[3]), "ruolo": str(r[5])}
        toks = norm(f["nome"]).split()
        if toks and len(toks[-1]) == 1:
            f["ini"], f["sur"] = toks[-1], " ".join(toks[:-1])
        else:
            f["ini"], f["sur"] = "", " ".join(toks)
        f["surc"] = f["sur"].replace(" ", "")
        fanta.append(f)
    return fanta

def surname_hit(o_toks, o_compact, f):
    if set(f["sur"].split()) & set(o_toks):
        return True
    fc = f["surc"]
    if len(fc) >= 4 and (fc in o_compact or o_compact[:len(fc)] == fc):
        return True
    for t in o_toks:
        if len(t) >= 4 and (t in fc or fc.startswith(t) or t.startswith(fc)):
            return True
    return False

def match(o, fanta):
    onome = norm(o["nome"]).split()
    oc = "".join(onome)
    osur1 = onome[0] if onome else ""
    ogiv = onome[-1][0] if len(onome) > 1 else ""
    oru, osq = o["ruolo"], norm(o["squadra"])
    cand = []
    for f in fanta:
        if not surname_hit(onome, oc, f):
            continue
        score = 0
        if f["ruolo"] == oru: score += 2
        if f["sq"] == osq: score += 2
        if f["ini"] and f["ini"] == ogiv: score += 3
        if f["sur"] == osur1 or f["surc"] == osur1: score += 1
        cand.append((score, f))
    cand.sort(key=lambda x: -x[0])
    return cand

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    ap.add_argument("players", nargs="?",
                    default=os.path.join(os.path.dirname(__file__), "..", "docs", "data", "players.json"))
    ap.add_argument("-o", "--out",
                    default=os.path.join(os.path.dirname(__file__), "fco_to_fanta.json"))
    args = ap.parse_args()

    fanta = load_fanta(args.xlsx)
    ours = json.load(open(args.players, encoding="utf-8"))
    cross, unm, ambig = {}, [], []
    for o in ours:
        c = match(o, fanta)
        if not c:
            unm.append(o); continue
        top = c[0][0]
        tied = [x for x in c if x[0] == top]
        if len(tied) > 1 and top < 5:
            ambig.append((o, tied)); continue
        cross[o["id"]] = {"fanta_id": c[0][1]["id"], "nome": o["nome"],
                          "squadra": o["squadra"], "ruolo": o["ruolo"]}
    json.dump(cross, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"Lista fantacalcio: {len(fanta)} giocatori")
    print(f"MATCHED {len(cross)}/{len(ours)}  |  AMBIGUI {len(ambig)}  |  NON TROVATI {len(unm)}")
    print(f"Crosswalk scritto: {os.path.abspath(args.out)}")
    if ambig:
        print("\n-- AMBIGUI (verifica a mano se ti servono) --")
        for o, t in ambig:
            print(f'  {o["nome"]} ({o["squadra"]},{o["ruolo"]}) -> ' +
                  " | ".join(f'{x[1]["nome"]}[{x[1]["id"]}]({x[1]["sq"]},{x[1]["ruolo"]})' for x in t[:4]))
    if unm:
        print(f"\n-- NON TROVATI ({len(unm)}): assenti dalla lista fantacalcio.it (trasferiti/non quotati) --")
        for o in unm:
            print(f'  {o["nome"]} ({o["squadra"]},{o["ruolo"]})')

if __name__ == "__main__":
    main()
