#!/usr/bin/env python3
"""
fetch_probabili.py — scarica dalla pagina PUBBLICA di fantacalcio.it le PROBABILI
FORMAZIONI d'asta (XI-tipo) + RIGORISTI + battitori di PUNIZIONE ("Calci da fermo")
per ogni club di Serie A, e le salva in pipeline/formazioni_fanta.json.

La pagina e' server-rendered e per ogni squadra ha un blocco regolare:
  NOME  Allenatore : ...  Modulo : 4-3-3 (alternativa ...)
  Probabile formazione (da dx a sx): GK; D, D, D, D; C, C, C; A, A, A.
  Ballottaggi : X/Y; ...   Rigoristi : a, b, c   Calci da fermo : a, b, c

I CORNER non ci sono qui: restano da SOSFanta. Rigoristi/Punizioni da qui sono
PRIMARI (vedi build_players.annota_formazioni_fanta), l'XI corrobora il ballottaggio.

SICUREZZA: se lo scrape fallisce o produce pochi club (< MIN_TEAMS), NON sovrascrive
il file esistente (che resta l'ultima versione buona). Cosi' un cambio di struttura
della pagina non rovina i dati.

Uso:  python fetch_probabili.py [url]
"""
import urllib.request, re, json, os, sys, html as ihtml

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "formazioni_fanta.json")
# URL fisso datato: se cambia, aggiornarlo qui (o passarlo da riga di comando).
URL = ("https://www.fantacalcio.it/news/calcio-italia/06_08_2026/"
       "asta-fantacalcio-le-probabili-formazioni-della-serie-a-enilive-2026-27-495558")
MIN_TEAMS = 18  # sotto questa soglia si considera lo scrape fallito e NON si sovrascrive

# squadre Serie A 2026/27 come compaiono nel testo (UPPERCASE, prima di "Allenatore")
TEAMS = ["ATALANTA", "BOLOGNA", "CAGLIARI", "COMO", "FIORENTINA", "FROSINONE",
         "GENOA", "INTER", "JUVENTUS", "LAZIO", "LECCE", "MILAN", "MONZA",
         "NAPOLI", "PARMA", "ROMA", "SASSUOLO", "TORINO", "UDINESE", "VENEZIA"]


def fetch_html(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=40).read().decode("utf-8", "ignore")


def plain_text(html: str) -> str:
    # via script/style (contengono JSON/JS che sporcano il testo, specie a fine articolo)
    html = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", html)
    t = re.sub(r"<[^>]+>", " ", html)
    return re.sub(r"\s+", " ", ihtml.unescape(t))


# un token è un nome plausibile: lettere (anche accentate), spazi, apostrofi, trattini,
# punto finale per le iniziali (es. "A. Oyono"). Niente cifre/parentesi/simboli.
_NAME_RE = re.compile(r"^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\- ]{1,}$")
_STOP = {"con", "in", "ballottaggio", "autore", "redazione", "leggi", "anche", "griglia"}


def _names(s: str) -> list[str]:
    """Spezza 'A, B, C' (o 'GK; D, D; A') in nomi puliti. Si FERMA al primo token
    non-nome (così non pesca il footer/rumore quando manca un delimitatore)."""
    out = []
    for tok in re.split(r"[;,]", s):
        n = tok.strip(" .")
        if not n or not _NAME_RE.match(n) or n.split()[0].lower() in _STOP:
            break  # fine della lista: da qui in poi è rumore
        out.append(n)
    return out


def parse(html: str) -> dict:
    txt = plain_text(html)
    # posizioni di inizio blocco: "NOME Allenatore"
    marks = []
    for t in TEAMS:
        m = re.search(r"\b" + re.escape(t) + r"\s+Allenatore", txt)
        if m:
            marks.append((m.start(), t))
    marks.sort()
    res = {}
    for i, (pos, team) in enumerate(marks):
        end = marks[i + 1][0] if i + 1 < len(marks) else len(txt)
        block = txt[pos:end]
        mm = re.search(r"Modulo\s*:\s*([0-9]+(?:-[0-9]+)+)", block)
        modulo = mm.group(1) if mm else ""
        fm = re.search(r"Probabile formazione[^:]*:\s*(.*?)(?:Ballottagg|Rigoristi|Calci da fermo)", block)
        titolari = _names(fm.group(1)) if fm else []
        # ballottaggi: "X/Y; W/Z; ..." (separatori ; , /) fino a Rigoristi
        bm = re.search(r"Ballottagg[^:]*:\s*(.*?)(?:Rigoristi|Calci da fermo|$)", block)
        ball = []
        if bm:
            for tok in re.split(r"[;,/]", bm.group(1)):
                n = tok.strip(" .")
                if n and "(" not in n and re.match(r"^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\- ]{1,}$", n):
                    ball.append(n)
        rm = re.search(r"Rigoristi\s*:\s*(.*?)(?:Calci da fermo|Ballottagg|$)", block)
        rig = _names(rm.group(1)) if rm else []
        pm = re.search(r"Calci da fermo\s*:\s*(.*)$", block)
        pun = _names(pm.group(1)) if pm else []
        # nome squadra come nei nostri dati (Titlecase)
        key = team.capitalize()
        res[key] = {"modulo": modulo, "titolari": titolari[:11], "ballottaggi": ball[:20],
                    "rigoristi": rig[:4], "punizioni": pun[:4]}
    return res


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else URL
    try:
        html = fetch_html(url)
        formazioni = parse(html)
    except Exception as e:
        print(f"ATTENZIONE: scrape probabili fallito ({e}). File invariato.")
        return 1
    ok = {k: v for k, v in formazioni.items() if len(v["titolari"]) >= 10}
    if len(ok) < MIN_TEAMS:
        print(f"ATTENZIONE: solo {len(ok)} squadre valide (< {MIN_TEAMS}). "
              f"Struttura pagina forse cambiata: file NON sovrascritto.")
        return 1
    data = {
        "_meta": {
            "fonte": "fantacalcio.it — probabili formazioni asta Serie A 2026/27",
            "url": url,
            "nota": "AUTO-SCRAPE (fetch_probabili.py). XI-tipo corrobora il ballottaggio; "
                    "rigoristi/punizioni ('Calci da fermo') PRIMARI su rigoreRank/punizioneRank. "
                    "Corner NON presenti qui (restano da SOSFanta). Se lo scrape fallisce, "
                    "l'ultimo file valido resta invariato.",
        },
        "formazioni": formazioni,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    tot_r = sum(len(v["rigoristi"]) for v in formazioni.values())
    tot_p = sum(len(v["punizioni"]) for v in formazioni.values())
    print(f"OK: {len(formazioni)} squadre -> {OUT}  (rigoristi {tot_r}, punizioni {tot_p})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
