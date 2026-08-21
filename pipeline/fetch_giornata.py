#!/usr/bin/env python3
"""
fetch_giornata.py — dati di GIORNATA per lo strumento Formazione (FULL, personale).
Tutto da fonti PUBBLICHE fantacalcio.it (nessun login):

  1) /statistiche-serie-a       -> statistiche stagionali per giocatore
       pg, mv, mfv, gol, gs, ass, rigSeg, rigCal, rp, amm, esp   (chiave = id fanta)
  2) /probabili-formazioni-serie-a -> partite + probabili + ballottaggi
       - fixtures: match casa|trasferta (data-teams-id)
       - per squadra: modulo + XI probabile (id dei titolari)
       - ballottaggi: id giocatore -> % (indice titolarita'/subentro)

Output: docs/data/giornata.json  (consumato dalla schermata Formazione della FULL)

Uso:  python fetch_giornata.py
"""
import urllib.request, re, json, os, html as ihtml
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "docs", "data", "giornata.json")
UA = "Mozilla/5.0"
STATS_URL = "https://www.fantacalcio.it/statistiche-serie-a"
PROB_URL = "https://www.fantacalcio.it/probabili-formazioni-serie-a"
QUOT_URL = "https://www.fantacalcio.it/quotazioni-fantacalcio"


def fetch_html(u):
    return urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA}), timeout=40).read().decode("utf-8", "ignore")


def num(s):
    s = (s or "").strip().replace(",", ".")
    try:
        return float(s) if "." in s else int(s)
    except ValueError:
        return 0


def team_map():
    """id squadra -> nome (dalla <select> Squadra delle quotazioni)."""
    h = fetch_html(QUOT_URL)
    m = {}
    for tid, nm in re.findall(r'<option value="(\d+)"[^>]*>([^<]+)</option>', h):
        nm = ihtml.unescape(nm).strip()
        if nm and nm != "Squadra":
            m.setdefault(tid, nm)
    return m


def parse_stats():
    h = fetch_html(STATS_URL)
    out = {}
    for r in re.findall(r'<tr class="player-row".*?</tr>', h, re.S):
        idm = re.search(r'/serie-a/squadre/[^/"]+/[^/"]+/(\d+)', r)
        if not idm:
            continue
        cell = dict(re.findall(r'data-col-key="([^"]+)">\s*([^<]*?)\s*<', r))
        rig = cell.get("rig", "0 / 0").split("/")
        out[idm.group(1)] = {
            "pg": num(cell.get("pg")), "mv": num(cell.get("mv")), "mfv": num(cell.get("mfv")),
            "gol": num(cell.get("gol")), "gs": num(cell.get("gs")), "ass": num(cell.get("ass")),
            "rigSeg": num(rig[0]) if rig else 0, "rigCal": num(rig[1]) if len(rig) > 1 else 0,
            "rp": num(cell.get("rp")), "amm": num(cell.get("amm")), "esp": num(cell.get("esp")),
        }
    return out


def parse_probabili(teams):
    h = fetch_html(PROB_URL)
    # fixtures: match casa|trasferta
    fixtures, team_match = [], {}
    for mid, home, away in re.findall(r'data-match-id="(\d+)"\s+data-teams-id="(\d+)\|(\d+)"', h):
        hn, an = teams.get(home, home), teams.get(away, away)
        fixtures.append({"matchId": mid, "home": hn, "away": an})
        team_match[hn] = {"opponent": an, "home": True}
        team_match[an] = {"opponent": hn, "home": False}
    # probabili per giocatore: liste "starters" (titolari, % = titolarità) e
    # "reserves" (riserve, % = subentro); data-status success=verde / warn=arancio.
    probabili = {}
    for sezione, block in re.findall(r'<ul class="player-list (starters|reserves)">(.*?)</ul>', h, re.S):
        status = "titolare" if sezione == "starters" else "riserva"
        for li in re.findall(r'<li class="player-item[^"]*"[^>]*>.*?</li>', block, re.S):
            st = re.search(r'data-status="([^"]*)"', li)
            role = re.search(r'class="role"\s+data-value="([a-z])"', li)
            idm = re.search(r'/serie-a/squadre/[^/"]+/[^/"]+/(\d+)', li)
            perc = re.search(r'aria-valuenow="(\d+)"', li)
            if not idm:
                continue
            probabili[idm.group(1)] = {
                "status": status,
                "perc": int(perc.group(1)) if perc else None,
                "conf": "alta" if (st and st.group(1) == "success") else "media",  # verde/arancio
                "ruolo": (role.group(1).upper() if role else None),
            }
    # commento testuale per squadra (sezione "Presentazione squadre")
    commento = {}
    csec = re.search(r'match-comment.*?(?=</main>|<footer|$)', h, re.S)
    scope = csec.group(0) if csec else h
    for nome, corpo in re.findall(r'<h4[^>]*>([^<]+)</h4>\s*<div class="comment[^"]*">(.*?)</div>', scope, re.S):
        txt = re.sub(r'<[^>]+>', " ", corpo)
        txt = ihtml.unescape(re.sub(r'\s+', " ", txt)).strip()
        if txt:
            commento[ihtml.unescape(nome).strip()] = txt
    return {"fixtures": fixtures, "teamMatch": team_match, "probabili": probabili, "commento": commento}


def main():
    teams = team_map()
    stats = parse_stats()
    prob = parse_probabili(teams)
    data = {"stats": stats, **prob, "numGiocatoriStat": len(stats)}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    print(f"giornata.json scritto: {os.path.abspath(OUT)}")
    tit = sum(1 for v in prob["probabili"].values() if v["status"] == "titolare")
    print(f"  statistiche: {len(stats)} giocatori")
    print(f"  partite: {len(prob['fixtures'])}  |  probabili: {len(prob['probabili'])} (titolari: {tit}) | commenti: {len(prob['commento'])}")
    print("  fixtures:", ", ".join(f"{x['home']}-{x['away']}" for x in prob["fixtures"][:5]), "...")


if __name__ == "__main__":
    main()
