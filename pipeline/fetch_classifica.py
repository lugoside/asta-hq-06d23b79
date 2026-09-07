#!/usr/bin/env python3
"""
fetch_classifica.py — classifica Serie A (forza squadre) da fantacalcio.it.

Per ogni squadra: posizione, punti, giocate, V/N/P, gol fatti (GF), gol subiti (GS),
differenza reti. Serve al motore Formazione per pesare la forza dell'avversario.
Fonde in docs/data/giornata.json → classifica[nomeSquadra] = {...}. (Totali; lo split
casa/trasferta di GF/GA lo calcola fetch_matches.py dai punteggi.)

Uso:  python fetch_classifica.py
"""
import urllib.request, re, json, os, html as ihtml

HERE = os.path.dirname(os.path.abspath(__file__))
GIORNATA = os.path.join(HERE, "..", "docs", "data", "giornata.json")
UA = "Mozilla/5.0"
URL = "https://www.fantacalcio.it/serie-a/classifica"

CELLS = {  # classe cella -> chiave
    "points": "pts", "played": "pg", "won": "v", "drawn": "n", "lost": "p",
    "goalsscored": "gf", "goalsconceded": "gs", "goalsdifference": "dr",
}


def num(s):
    try:
        return int(re.sub(r"[^\d-]", "", s or ""))
    except ValueError:
        return 0


def main():
    h = urllib.request.urlopen(urllib.request.Request(URL, headers={"User-Agent": UA}), timeout=40).read().decode("utf-8", "ignore")
    classifica = {}
    for row in re.findall(r'<tr data-name="[^"]+".*?</tr>', h, re.S):
        name = re.search(r'data-name="([^"]+)"', row)
        pos = re.search(r'data-team-position="(\d+)"', row)
        # la pagina ha 2 tabelle (completa + ridotta): tieni solo la riga completa
        if not name or 'class="goalsscored' not in row:
            continue
        team = ihtml.unescape(name.group(1)).strip()
        rec = {"rank": num(pos.group(1)) if pos else 0}
        for cls, key in CELLS.items():
            m = re.search(r'<td class="' + cls + r'[^"]*"[^>]*>\s*([^<]*?)\s*<', row)
            rec[key] = num(m.group(1)) if m else 0
        classifica[team] = rec
    data = json.load(open(GIORNATA, encoding="utf-8")) if os.path.exists(GIORNATA) else {}
    data["classifica"] = classifica
    json.dump(data, open(GIORNATA, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"classifica scritta: {len(classifica)} squadre")
    top = sorted(classifica.items(), key=lambda kv: kv[1]["rank"])[:3]
    for t, r in top:
        print(f"  {r['rank']}. {t}: {r['pts']}pt · GF {r['gf']} · GS {r['gs']} · {r['pg']}g")


if __name__ == "__main__":
    main()
