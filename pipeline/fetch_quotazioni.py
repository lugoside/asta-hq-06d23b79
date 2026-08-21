#!/usr/bin/env python3
"""
fetch_quotazioni.py — scarica le Quotazioni UFFICIALI di fantacalcio.it dalla
pagina PUBBLICA (nessun login) e le salva in raw/quotazioni_fanta.json.

La pagina https://www.fantacalcio.it/quotazioni-fantacalcio e' server-rendered:
ogni <tr class="player-row"> porta id nativo (nel link giocatore), ruolo, squadra
(via data-filter-team-id + la select), QUOT iniziale/attuale e FVM. E' la fonte
AUTOREVOLE del listone (id reali, QUOT, FVM), scaricabile in automatico.

NB: i nomi qui sono ABBREVIATI ("Martinez L."); i nomi completi + `overall` si
recuperano poi unendo col listone fantacalcio-online in build_listone_fanta.py.
La pagina include TUTTI i giocatori (anche i trasferiti "fuori lista", che non
sono marcati qui): scelta consapevole, non si escludono.

Uso:  python fetch_quotazioni.py [stagione]   (default 2026/27)
Output: pipeline/raw/quotazioni_fanta.json
"""
import urllib.request, re, json, os, sys, html as ihtml
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
RAW_DIR = os.path.join(HERE, "raw")
URL = "https://www.fantacalcio.it/quotazioni-fantacalcio"
ROLE = {"p": "P", "d": "D", "c": "C", "a": "A"}


def fetch_html(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=40).read().decode("utf-8", "ignore")


def team_map(html: str) -> dict:
    """id squadra -> nome, dalla <select> Squadra."""
    teams = {}
    for m in re.finditer(r'<option value="(\d+)"[^>]*>([^<]+)</option>', html):
        nm = ihtml.unescape(m.group(2)).strip()
        if nm and nm != "Squadra":
            teams.setdefault(m.group(1), nm)
    return teams


def parse_quotazioni(html: str) -> list[dict]:
    teams = team_map(html)
    out = []
    for r in re.findall(r'<tr class="player-row".*?</tr>', html, re.S):
        tid = re.search(r'data-filter-team-id="(\d+)"', r)
        idm = re.search(r'/serie-a/squadre/[^/"]+/[^/"]+/(\d+)', r)
        role = re.search(r'class="role"\s+data-value="([a-z])"', r)
        name = re.search(r'player-name player-link"[^>]*>\s*<span>([^<]+)</span>', r)
        qi = re.search(r'data-col-key="c_qi">\s*([\d.]+)', r)
        qa = re.search(r'data-col-key="c_qa">\s*([\d.]+)', r)   # quotazione ATTUALE (cambia in stagione)
        fvm = re.search(r'data-col-key="c_fvm">\s*([\d.]+)', r)
        if not (idm and name and role and qi and fvm):
            continue
        out.append({
            "id": idm.group(1),
            "nome": ihtml.unescape(name.group(1)).strip(),
            "squadra": teams.get(tid.group(1) if tid else "", (tid.group(1) if tid else "")),
            "ruolo": ROLE.get(role.group(1), "C"),
            "qi": int(float(qi.group(1))),
            "qa": int(float(qa.group(1))) if qa else int(float(qi.group(1))),
            "fvm": int(float(fvm.group(1))),
        })
    return out


def main():
    html = fetch_html(URL)
    players = parse_quotazioni(html)
    if len(players) < 300:
        raise SystemExit(f"Solo {len(players)} giocatori estratti: la pagina potrebbe essere cambiata.")
    os.makedirs(RAW_DIR, exist_ok=True)
    out = os.path.join(RAW_DIR, "quotazioni_fanta.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(players, f, ensure_ascii=False)
    print(f"OK: {len(players)} quotazioni -> {out}")
    print("Per ruolo:", dict(Counter(p["ruolo"] for p in players)))
    print("Squadre:", len(set(p["squadra"] for p in players)))
    top = sorted(players, key=lambda p: -p["fvm"])[:5]
    print("Top FVM:", ", ".join(f'{p["nome"]}({p["fvm"]})' for p in top))


if __name__ == "__main__":
    main()
