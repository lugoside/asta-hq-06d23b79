#!/usr/bin/env python3
"""
fetch_goal_formazioni.py — formazioni-tipo da goal.com (PUBBLICA, server-rendered).
Per ogni club estrae: 'titolari' (la FORMAZIONE TIPO) e 'ballottaggi' ('Altri
possibili titolari'). È una delle 3 fonti del CONSENSO formazioni (con SOSFanta e
fanta.it). Output: pipeline/goal_formazioni.json.

Struttura pagina (nel corpo articolo, i blocchi compaiono 2x = indice+contenuto;
si tiene quello con l'XI più lungo):
  PROBABILE FORMAZIONE <TEAM> FORMAZIONE TIPO (Allenatore: X) (4-3-3):
  GK; D, D, D, D; C, C, C; A, A, A. Altri possibili titolari: N1, N2, ...

GUARDIA: se < MIN_TEAMS club validi, NON sovrascrive il file esistente.
Uso: python fetch_goal_formazioni.py [url]
"""
import urllib.request, re, json, os, sys, html as ihtml

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "goal_formazioni.json")
URL = ("https://www.goal.com/it/liste/fantacalcio-formazioni-titolari-serie-a-2026-2027-"
       "tutte-le-squadre-tipo/blt5527c89487e5b7d3")
MIN_TEAMS = 18

TEAMS = ["ATALANTA", "BOLOGNA", "CAGLIARI", "COMO", "FIORENTINA", "FROSINONE",
         "GENOA", "INTER", "JUVENTUS", "LAZIO", "LECCE", "MILAN", "MONZA",
         "NAPOLI", "PARMA", "ROMA", "SASSUOLO", "TORINO", "UDINESE", "VENEZIA"]
# stop-word che chiudono la lista "Altri possibili titolari"
_STOP = re.compile(r"(Pubblicit|PROBABILE FORMAZIONE|FORMAZIONE TIPO|\.)", re.I)


def fetch_html(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=40).read().decode("utf-8", "ignore")


def _names(s: str) -> list[str]:
    out = []
    for tok in re.split(r"[;,]", s):
        n = tok.strip(" .")
        if n and re.match(r"^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\- ]{1,}$", n):
            out.append(n)
        elif n:
            break  # rumore: fine lista
    return out


def parse(html: str) -> dict:
    txt = re.sub(r"<[^>]+>", " ", ihtml.unescape(html))
    txt = re.sub(r"\s+", " ", txt)
    res = {}
    for team in TEAMS:
        best_xi, best_alt = [], []
        # tutte le occorrenze del blocco di questa squadra (indice + contenuto)
        for m in re.finditer(r"\b" + team + r"\b\s*FORMAZIONE TIPO\s*\([^)]*\)\s*\([0-9-]+\):\s*(.*)", txt):
            tail = m.group(1)
            # XI fino a "Altri possibili titolari" (confine affidabile: evita il taglio su "D. Veiga")
            xi_raw = re.split(r"Altri possibili titolari|Pubblicit|PROBABILE FORMAZIONE", tail, 1)[0]
            xi = _names(xi_raw)[:11]
            alt = []
            am = re.search(r"Altri possibili titolari:\s*(.*)", tail)
            if am:
                alt_raw = _STOP.split(am.group(1))[0]
                alt = _names(alt_raw)
            if len(xi) > len(best_xi):
                best_xi, best_alt = xi, alt
        if len(best_xi) >= 10:
            res[team.capitalize()] = {"titolari": best_xi, "ballottaggi": best_alt}
    return res


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else URL
    try:
        data = parse(fetch_html(url))
    except Exception as e:
        print(f"ATTENZIONE: scrape goal.com fallito ({e}). File invariato.")
        return 1
    if len(data) < MIN_TEAMS:
        print(f"ATTENZIONE: solo {len(data)} club validi (< {MIN_TEAMS}). File NON sovrascritto.")
        return 1
    out = {"_meta": {"fonte": "goal.com — formazioni-tipo Serie A 2026/27", "url": url,
                     "nota": "titolari = FORMAZIONE TIPO; ballottaggi = 'Altri possibili titolari'. "
                             "Una delle 3 fonti del consenso formazioni."},
           "formazioni": data}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    tot_b = sum(len(v["ballottaggi"]) for v in data.values())
    print(f"OK: {len(data)} club -> {OUT}  (ballottaggi totali: {tot_b})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
