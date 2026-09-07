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
import urllib.request, re, json, os, html as ihtml, datetime
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


def calendar_fixtures():
    """fixtures (avversario + casa/trasferta) della giornata ATTIVA dal CALENDARIO.
    Fallback quando la pagina probabili non ha ancora le partite (tra una giornata e
    l'altra / durante le soste): il calendario le espone sempre, con largo anticipo.
    slug partita = 'casa-trasferta' → nomi via capitalize (set Serie A a parola singola)."""
    base = "https://www.fantacalcio.it/serie-a/calendario"
    h = fetch_html(base)
    m = re.search(r'class="active"\s+href="/serie-a/calendario/(\d+)"', h)
    if not m:
        return [], {}
    c = fetch_html(f"{base}/{m.group(1)}")
    fixtures, team_match, seen = [], {}, set()
    for slug, mid in re.findall(r'href="https://www\.fantacalcio\.it/serie-a/calendario/\d+/[0-9-]+/([a-z0-9-]+)/(\d+)"', c):
        if mid in seen:
            continue
        seen.add(mid)
        parts = slug.split("-")
        if len(parts) != 2:
            continue
        home, away = parts[0].capitalize(), parts[1].capitalize()
        fixtures.append({"matchId": mid, "home": home, "away": away})
        team_match[home] = {"opponent": away, "home": True}
        team_match[away] = {"opponent": home, "home": False}
    return fixtures, team_match


def main():
    teams = team_map()
    stats = parse_stats()
    prob = parse_probabili(teams)
    # fallback: se i probabili non hanno ancora le partite, prendi i fixture dal calendario
    if not prob.get("teamMatch"):
        try:
            fx, tm = calendar_fixtures()
            if tm:
                prob["teamMatch"] = tm
                if not prob.get("fixtures"):
                    prob["fixtures"] = fx
                print(f"  probabili senza partite → fallback calendario: {len(tm)} squadre, {len(fx)} partite")
        except Exception as e:
            print(f"  fallback calendario non riuscito: {e}")
    # MERGE nel giornata.json esistente: aggiorna stats/probabili/teamMatch/fixtures/commento
    # ma PRESERVA le chiavi degli altri scraper (detail, teamStats, classifica, lastFullGiornata)
    # → così una run "solo probabili" non cancella i dati del motore.
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    data = json.load(open(OUT, encoding="utf-8")) if os.path.exists(OUT) else {}
    data["stats"] = stats
    data["numGiocatoriStat"] = len(stats)
    for k in ("probabili", "teamMatch", "fixtures", "commento"):
        if k in prob:
            data[k] = prob[k]
    # timestamp UTC dell'ultimo aggiornamento dati di giornata (mostrato in app in forma relativa)
    data["aggiornato"] = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    print(f"giornata.json scritto: {os.path.abspath(OUT)}")
    tit = sum(1 for v in prob["probabili"].values() if v["status"] == "titolare")
    print(f"  statistiche: {len(stats)} giocatori")
    print(f"  partite: {len(prob['fixtures'])}  |  probabili: {len(prob['probabili'])} (titolari: {tit}) | commenti: {len(prob['commento'])}")
    print("  fixtures:", ", ".join(f"{x['home']}-{x['away']}" for x in prob["fixtures"][:5]), "...")


if __name__ == "__main__":
    main()
