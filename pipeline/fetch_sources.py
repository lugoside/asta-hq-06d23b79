"""fetch_sources.py — scarica il listone ufficiale 2026/27 da fantacalcio-online.com
e lo salva grezzo in pipeline/raw/listone.json (schema dell'app).

Vedi pipeline/sources.md per la struttura della pagina. Nessun login richiesto.

Uso:  python fetch_sources.py            # stagione di default
      python fetch_sources.py 2026-2027
"""
from __future__ import annotations
import gzip
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RAW_DIR = os.path.join(HERE, "raw")
STAGIONE_DEFAULT = "2026-2027"
URL_TMPL = "https://www.fantacalcio-online.com/it/serie-a/{stag}/quotazioni"

# codice ruolo (data-prop-name="role") -> ruolo Classic
ROLE_MAP = {"1": "P", "2": "D", "4": "C", "6": "A"}
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) FantaAsta/1.0"


def fetch_html(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=40) as r:
        data = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            data = gzip.decompress(data)
    return data.decode("utf-8", "ignore")


def _prop(block: str, name: str) -> str:
    m = re.search(r'data-prop-name="' + re.escape(name) + r'"[^>]*>([^<]*)<', block)
    return m.group(1).strip() if m else ""


def _num(s: str, default: float = 0.0) -> float:
    try:
        return float(s.replace(",", "."))
    except (ValueError, AttributeError):
        return default


def _titlecase_cognome(last: str) -> str:
    # i cognomi arrivano in MAIUSCOLO: "MARTINEZ" -> "Martinez"
    return " ".join(w.capitalize() for w in last.split())


def parse_listone(html: str) -> list[dict]:
    parts = html.split('class="player-element"')[1:]
    players = []
    for b in parts:
        b = b[:3500]  # basta l'inizio del blocco
        role = _prop(b, "role")
        ruolo = ROLE_MAP.get(role)
        if not ruolo:
            continue
        first = _prop(b, "firstName")
        last = _titlecase_cognome(_prop(b, "lastName"))
        nome = (f"{last} {first}".strip() if last else first).strip()
        squadra = _prop(b, "name")  # realteam -> name (primo 'name' del blocco)
        kap = _num(_prop(b, "kapitals"))
        overall = _num(_prop(b, "overall"))
        bonus = _num(_prop(b, "bonus"))
        lineup = _num(_prop(b, "lineupRating"))
        pid = _prop(b, "id")  # primo id = id giocatore
        if not nome:
            continue
        players.append({
            "id": f"fco{pid}",
            "nome": nome,
            "squadra": squadra,
            "ruolo": ruolo,
            "ruoloMantra": _prop(b, "fieldPositionLabel"),
            "qi": max(1, round(kap)),
            "fvm": max(1, round(kap)),
            "overall": overall,
            "bonusAtteso": bonus,
            "lineupRating": lineup,
            "isNuovo": kap <= 1 and overall < 5.5,
            "stats2526": {},  # storico non presente in questa fonte
            "note": "",
        })
    return players


def main():
    stag = sys.argv[1] if len(sys.argv) > 1 else STAGIONE_DEFAULT
    url = URL_TMPL.format(stag=stag)
    print(f"Scarico: {url}")
    html = fetch_html(url)
    players = parse_listone(html)
    if len(players) < 300:
        raise SystemExit(f"Solo {len(players)} giocatori estratti: la pagina potrebbe essere cambiata. "
                         f"Controlla pipeline/sources.md.")
    os.makedirs(RAW_DIR, exist_ok=True)
    out = os.path.join(RAW_DIR, "listone.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(players, f, ensure_ascii=False)
    from collections import Counter
    print(f"OK: {len(players)} giocatori -> {out}")
    print("Per ruolo:", dict(Counter(p["ruolo"] for p in players)))
    top = sorted(players, key=lambda p: -p["qi"])[:6]
    print("Top per valore:", ", ".join(f"{p['nome']}({p['qi']})" for p in top))


if __name__ == "__main__":
    main()
