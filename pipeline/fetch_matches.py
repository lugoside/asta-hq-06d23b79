#!/usr/bin/env python3
"""
fetch_matches.py — dati MATCH-BY-MATCH per la MIA rosa da fantacalcio.it (server-rendered).

Dalla pagina riepilogo di ogni partita (…/calendario/<g>/<season>/<slug>/<id>/riepilogo)
si leggono le formazioni titolari con gli EVENTI per giocatore (fantaId):
  - "Sostituito" (id 14) → USCITO a gara in corso   ← dato mancante altrove
  - "Gol subito" (id 4)  → per il CLEAN SHEET del portiere (titolare senza gol subiti)
  - Gol/Assist/Ammonizione/Espulsione + lato CASA/TRASFERTA (container team-lineup home/away)
Aggrega SOLO i miei ~25 (my_roster_ids.json) e fonde in giornata.json → detail[fid].match.

CACHE: le partite GIOCATE non cambiano → pipeline/matches_cache.json (matchId → parse).
A ogni run si scaricano solo le partite nuove. Scan giornate 1..38, stop al futuro.

Uso:  python fetch_matches.py
"""
import urllib.request, re, json, os, time, html as ihtml
from urllib.parse import quote

HERE = os.path.dirname(os.path.abspath(__file__))
GIORNATA = os.path.join(HERE, "..", "docs", "data", "giornata.json")
ROSTER = os.path.join(HERE, "my_roster_ids.json")
CACHE = os.path.join(HERE, "matches_cache.json")
UA = "Mozilla/5.0"
CAL = "https://www.fantacalcio.it/serie-a/calendario/{}"


def fetch(u):
    return urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA}), timeout=40).read().decode("utf-8", "ignore")


def match_urls(g):
    """URL base delle 10 partite della giornata g (dal calendario)."""
    h = fetch(CAL.format(g))
    out = []
    for u in re.findall(r'href="(https://www\.fantacalcio\.it/serie-a/calendario/\d+/[0-9-]+/[a-z0-9-]+/(\d+))"', h):
        if u[0] not in [x[0] for x in out]:
            out.append(u)
    # de-dup mantenendo l'ordine
    seen, res = set(), []
    for url, mid in out:
        if mid not in seen:
            seen.add(mid); res.append((quote(ihtml.unescape(url), safe="/:?=&%#"), mid))
    return res


def parse_match(h, g, home, away):
    """Titolari con eventi + lato casa/trasferta + punteggio. None se non giocata."""
    hh = h.find('team-lineup home"')
    ha = h.find('team-lineup away"')
    if hh < 0 or ha < 0:
        return None
    sh = re.search(r'class="score-home[^"]*"[^>]*>\s*(\d+)', h)
    sa = re.search(r'class="score-away[^"]*"[^>]*>\s*(\d+)', h)
    hg = int(sh.group(1)) if sh else None
    ag = int(sa.group(1)) if sa else None
    lo, hi = (hh, ha) if hh < ha else (ha, hh)
    home_first = hh < ha
    players = []
    for m in re.finditer(r'<li class="player zone-\d+[^"]*">.*?</li>', h, re.S):
        pos, li = m.start(), m.group(0)
        fid = re.search(r'/serie-a/squadre/[^/"]+/[^/"]+/(\d+)', li)
        if not fid:
            continue
        role = re.search(r'player-role role" data-value="([a-z])"', li)
        # eventi come [titolo, ammontare] (assist/gol multipli = un evento con data-amount)
        evs = []
        for fig in re.findall(r'<figure class="player-event[^>]*>', li):
            t = re.search(r'title="([^"]*)"', fig)
            if not t:
                continue
            n = re.search(r'data-amount="(\d+)"', fig)
            evs.append([t.group(1), int(n.group(1)) if n else 1])
        in_first_block = lo <= pos < hi
        side = ("home" if home_first else "away") if in_first_block else ("away" if home_first else "home")
        players.append({"fid": fid.group(1), "role": role.group(1) if role else "?", "side": side, "ev": evs})
    if not players:
        return None
    return {"gio": g, "home": home, "away": away, "hg": hg, "ag": ag, "players": players}


def main():
    roster = json.load(open(ROSTER, encoding="utf-8"))["roster"]
    my_ids = {str(p["fantaId"]) for p in roster}
    cache = json.load(open(CACHE, encoding="utf-8")) if os.path.exists(CACHE) else {}

    fetched = 0
    for g in range(1, 39):
        try:
            urls = match_urls(g)
        except Exception as e:
            print(f"  g{g}: calendario non disponibile ({e})"); break
        if not urls:
            break
        played_any = False
        for url, mid in urls:
            if mid in cache:
                played_any = True; continue
            slug = url.split("/")[-2]                 # es. "genoa-como" → home-away
            parts = slug.split("-")
            home = parts[0].capitalize() if len(parts) == 2 else None
            away = parts[1].capitalize() if len(parts) == 2 else None
            try:
                parsed = parse_match(fetch(url + "/riepilogo"), g, home, away)
            except Exception as e:
                print(f"  match {mid}: errore {e}"); continue
            time.sleep(0.35)
            if parsed:
                cache[mid] = parsed; fetched += 1; played_any = True
        if not played_any:
            break  # giornata futura: stop
    json.dump(cache, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)

    # sede (casa/trasferta) per SQUADRA e giornata, dal match cache (completo di tutte le gare) →
    # ogni voto in byGio prende la sede giusta ANCHE per i subentranti (il lato dal riepilogo perde
    # chi entra a gara in corso). Chiave = squadra normalizzata (accenti/maiuscole tolti).
    import unicodedata
    norm = lambda s: unicodedata.normalize("NFD", str(s or "")).encode("ascii", "ignore").decode().lower().strip()
    venue_team_gio = {}   # {squadra_norm: {gio(str): "home"|"away"}}
    for mid, mt in cache.items():
        gio = str(mt.get("gio")); h_, a_ = mt.get("home"), mt.get("away")
        if h_:
            venue_team_gio.setdefault(norm(h_), {})[gio] = "home"
        if a_:
            venue_team_gio.setdefault(norm(a_), {})[gio] = "away"
    team_by_fid = {str(p["fantaId"]): norm(p.get("squadra")) for p in roster}

    # aggrega per i miei 25 — SOLO i dati che la pagina-giocatore non dà e che qui sono
    # esatti (basati sulla PRESENZA dell'evento, non sull'ammontare): uscite, clean sheet,
    # presenze da titolare per sede. Gol/assist/gol-subiti (con split casa/trasferta) restano
    # dalla pagina-giocatore, più affidabili (evento unico con data-amount).
    agg = {}
    for mid, mt in cache.items():
        for pl in mt["players"]:
            fid = pl["fid"]
            if fid not in my_ids:
                continue
            a = agg.setdefault(fid, {"matches": 0, "subOff": 0, "csHome": 0, "csAway": 0,
                                     "assHome": 0, "assAway": 0, "role": pl["role"],
                                     "presHome": 0, "presAway": 0})
            a["matches"] += 1
            home = pl["side"] == "home"
            a["presHome" if home else "presAway"] += 1
            titles = [e[0] for e in pl["ev"]]
            if "Sostituito" in titles:
                a["subOff"] += 1
            a["assHome" if home else "assAway"] += sum(e[1] for e in pl["ev"] if e[0] == "Assist")
            if pl["role"] == "p" and "Gol subito" not in titles:  # portiere titolare senza gol subiti
                a["csHome" if home else "csAway"] += 1

    # aggrega GF/GA CASA/TRASFERTA per OGNI squadra dai punteggi (forza offensiva/difensiva per sede)
    teamStats = {}
    blank = lambda: {"homeGP": 0, "homeGF": 0, "homeGA": 0, "awayGP": 0, "awayGF": 0, "awayGA": 0}
    for mid, mt in cache.items():
        h_, a_, hg, ag = mt.get("home"), mt.get("away"), mt.get("hg"), mt.get("ag")
        if not h_ or not a_ or hg is None or ag is None:
            continue
        H = teamStats.setdefault(h_, blank()); A = teamStats.setdefault(a_, blank())
        H["homeGP"] += 1; H["homeGF"] += hg; H["homeGA"] += ag
        A["awayGP"] += 1; A["awayGF"] += ag; A["awayGA"] += hg

    # ultima giornata COMPLETATA = max giornata con tutte e 10 le partite in cache
    from collections import Counter
    per_gio = Counter(mt["gio"] for mt in cache.values())
    full = [gg for gg, n in per_gio.items() if n >= 10]
    last_full = max(full) if full else (max(per_gio) if per_gio else 0)

    # fonde in giornata.json → detail[fid].match + teamStats + lastFullGiornata
    data = json.load(open(GIORNATA, encoding="utf-8")) if os.path.exists(GIORNATA) else {}
    detail = data.setdefault("detail", {})
    for fid, a in agg.items():
        d = detail.setdefault(fid, {})
        d["match"] = a
        # FM casa/trasferta: media dei fm di byGio splittati per sede (fonte fm = pagina-giocatore)
        bg = d.get("byGio") or {}
        sides = venue_team_gio.get(team_by_fid.get(fid, ""), {})
        hv, av = [], []
        for gio, rec in bg.items():
            s = sides.get(str(gio)); fm = (rec or {}).get("fm")
            if fm is None or s is None:
                continue
            (hv if s == "home" else av).append(fm)
        d.pop("fmHome", None); d.pop("nHome", None); d.pop("fmAway", None); d.pop("nAway", None)
        if hv:
            d["fmHome"] = round(sum(hv) / len(hv), 2); d["nHome"] = len(hv)
        if av:
            d["fmAway"] = round(sum(av) / len(av), 2); d["nAway"] = len(av)
    data["teamStats"] = teamStats
    data["lastFullGiornata"] = last_full
    data["numMatchesCache"] = len(cache)
    json.dump(data, open(GIORNATA, "w", encoding="utf-8"), ensure_ascii=False)

    print(f"partite in cache: {len(cache)} (+{fetched} nuove) · miei aggregati: {len(agg)} · teamStats: {len(teamStats)} · ultima giornata completa: {last_full}")
    for t in list(teamStats)[:4]:
        s = teamStats[t]
        print(f"  {t}: casa {s['homeGF']}-{s['homeGA']} ({s['homeGP']}g) · tras {s['awayGF']}-{s['awayGA']} ({s['awayGP']}g)")


if __name__ == "__main__":
    main()
