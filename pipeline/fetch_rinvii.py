#!/usr/bin/env python3
"""
fetch_rinvii.py — gestione POSTICIPI/SOSPENSIONI secondo la regola della lega.

Regola lega: si aspetta il recupero di una gara SOLO se giocato ENTRO la 1ª partita del
turno successivo; se spostata OLTRE, ai giocatori di quelle squadre va il 6 POLITICO
(niente bonus/malus) per quella giornata. Stessa filosofia nei calcoli del tool.

Qui: dal calendario (data+ora per match) determino, per la giornata corrente G e la
precedente, le squadre la cui gara è "rinviata-oltre" = datetime > firstKickoff(G+1).
Scrivo in giornata.json:
  - giornataCorrente: G
  - rinvii: { "<N>": [squadre rinviate-oltre in N] }
  - lastFullGiornata RAFFINATO: una giornata è "conclusa" se ogni sua gara è GIOCATA
    (in matches_cache) oppure rinviata-oltre (→ 6 politico applicato, non si aspetta).

Uso:  python fetch_rinvii.py   (dopo fetch_matches, che mantiene matches_cache.json)
"""
import urllib.request, re, json, os, datetime
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
GIORNATA = os.path.join(HERE, "..", "docs", "data", "giornata.json")
CACHE = os.path.join(HERE, "matches_cache.json")
UA = "Mozilla/5.0"
BASE = "https://www.fantacalcio.it/serie-a/calendario"
try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("Europe/Rome")
except Exception:
    TZ = None

CAP = {}  # slug particolari → nome (nessuno nel set 2026-27)
name = lambda s: CAP.get(s, s.capitalize())


def fetch(u):
    return urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA}), timeout=40).read().decode("utf-8", "ignore")


def active_giornata():
    m = re.search(r'class="active"\s+href="/serie-a/calendario/(\d+)"', fetch(BASE))
    return int(m.group(1)) if m else None


def _raw(g):
    """[(slug, home, away, datetime)] della pagina giornata g (dedup per slug)."""
    c = fetch(f"{BASE}/{g}")
    out, seen = [], set()
    for date_s, tm, slug in re.findall(
        r'startDate"\s+content="(\d{4}-\d{2}-\d{2})"[^>]*>\s*<span class="day">[^<]*</span>\s*<span class="hours">\s*(\d{1,2}[:.]\d{2})[^<]*</span>.*?match-score unstyled" href="[^"]*/([a-z0-9-]+)/\d+"',
        c, re.S):
        if slug in seen:
            continue
        seen.add(slug)
        parts = slug.split("-")
        if len(parts) != 2:
            continue
        y, mo, da = map(int, date_s.split("-"))
        hh, mm = re.split(r"[:.]", tm)
        out.append((slug, name(parts[0]), name(parts[1]),
                    datetime.datetime(y, mo, da, int(hh), int(mm), tzinfo=TZ)))
    return out


# ⚠️ la pagina di una giornata include anche il WIDGET del turno attivo (date più precoci):
# per leggere le partite REALI di g != attiva bisogna ESCLUDERE gli slug del turno attivo.
def matches_of(g, exclude=frozenset()):
    return {(h, a): dt for slug, h, a, dt in _raw(g) if slug not in exclude}


def first_kickoff(g, exclude=frozenset()):
    m = matches_of(g, exclude)
    return min(m.values()) if m else None


def main():
    G = active_giornata()
    if not G:
        print("giornata attiva non determinata"); return
    cache = json.load(open(CACHE, encoding="utf-8")) if os.path.exists(CACHE) else {}
    played_per_gio = Counter(mt.get("gio") for mt in cache.values())
    active_slugs = frozenset(slug for slug, *_ in _raw(G))   # widget del turno attivo, da escludere altrove

    def excl(n):
        return frozenset() if n == G else active_slugs

    rinvii = {}
    # calcola per la giornata precedente (consuntivo) e la corrente (consigliato)
    for N in (G - 1, G):
        if N < 1:
            continue
        try:
            fk_next = first_kickoff(N + 1, excl(N + 1))
        except Exception:
            fk_next = None
        if not fk_next:
            continue
        try:
            ms = matches_of(N, excl(N))
        except Exception:
            ms = {}
        oltre = []
        for (h, a), dt in ms.items():
            if dt > fk_next:                     # spostata OLTRE la 1ª del turno successivo
                oltre += [h, a]
        if oltre:
            rinvii[str(N)] = sorted(set(oltre))

    # RAFFINA lastFullGiornata: una giornata è conclusa se ogni gara è giocata O rinviata-oltre
    data = json.load(open(GIORNATA, encoding="utf-8")) if os.path.exists(GIORNATA) else {}
    last_full = data.get("lastFullGiornata", 0) or 0
    for N in (G - 1, G):
        if N < 1:
            continue
        played = played_per_gio.get(N, 0)
        oltre_n = len(rinvii.get(str(N), [])) // 2   # coppie squadra → n° match
        if played + oltre_n >= 10 and N > last_full:
            last_full = N

    # Il marker "active" del sito resta sulla giornata appena CONCLUSA finché non parte la
    # successiva (tra un turno e l'altro): se la corrente è già completa, il turno da
    # PREPARARE è last_full+1. Senza questa riconciliazione l'app mostrerebbe come "prossimo
    # turno" partite GIÀ giocate (teamMatch preso dal calendario del turno attivo lagging).
    upcoming = last_full + 1 if last_full >= G else G
    if upcoming != G:
        try:
            up_matches = matches_of(upcoming, active_slugs)   # {(h,a):dt} REALI del turno da preparare
            fx = data.get("fixtures") or []
            fx_pairs = {(f.get("home"), f.get("away")) for f in fx}
            if fx and (fx_pairs & set(up_matches.keys())):
                # i fixtures (da probabili) sono GIÀ del turno da preparare → teamMatch coerente coi
                # fixtures (stesse partite, così ogni squadra ha l'avversario: no squadre scoperte)
                tm = {}
                for f in fx:
                    if f.get("home") and f.get("away"):
                        tm[f["home"]] = {"opponent": f["away"], "home": True}
                        tm[f["away"]] = {"opponent": f["home"], "home": False}
                src = "fixtures"
            else:
                # fixtures stantii (turno concluso) → ricostruisci dal calendario del turno da preparare
                tm = {}
                for (h, a) in up_matches:
                    tm[h] = {"opponent": a, "home": True}
                    tm[a] = {"opponent": h, "home": False}
                src = "calendario"
            if tm:
                data["teamMatch"] = tm
                print(f"  turno attivo {G} gia' concluso -> preparo la {upcoming}: teamMatch da {src} ({len(tm) // 2} partite)")
        except Exception as e:
            print(f"  rebuild teamMatch per {upcoming} non riuscito: {e}")
    # rete di sicurezza (sempre): ogni squadra dei fixtures deve avere l'avversario in teamMatch
    tmm = data.setdefault("teamMatch", {})
    for f in (data.get("fixtures") or []):
        h, a = f.get("home"), f.get("away")
        if h and a:
            tmm.setdefault(h, {"opponent": a, "home": True})
            tmm.setdefault(a, {"opponent": h, "home": False})

    data["giornataCorrente"] = upcoming
    data["rinvii"] = rinvii
    data["lastFullGiornata"] = last_full
    json.dump(data, open(GIORNATA, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"giornata corrente {upcoming} (attiva sito {G}) | lastFullGiornata {last_full} | rinvii-oltre: {rinvii or 'nessuno'}")


if __name__ == "__main__":
    main()
