#!/usr/bin/env python3
"""
should_update.py — GATE per l'aggiornamento dati stagionale.

Vogliamo UN aggiornamento la notte DOPO l'ultima partita di ogni giornata di Serie A.
Il cron di GitHub è statico → questo script decide a runtime:
  esegui SOLO se IERI (fuso Europe/Rome) era il giorno dell'ultima partita di una giornata.

Come (robusto agli intrecci di date fra giornate sulla stessa pagina): raccoglie
l'UNIONE delle date-partita attorno a ora (pagine calendario G-1/G/G+1) e applica il
segnale "una giornata si è chiusa ieri" = IERI c'erano partite E OGGI non ce ne sono.
(Così aspetta l'eventuale posticipo del lunedì e gestisce i turni infrasettimanali.)

Avvio manuale (workflow_dispatch): FORCE_RUN=1 → esegue sempre.

Scrive should_run=true|false su $GITHUB_OUTPUT (per gli step successivi della Action).
Uso locale:  python should_update.py
"""
import urllib.request, re, os, datetime

UA = "Mozilla/5.0"
BASE = "https://www.fantacalcio.it/serie-a/calendario"
try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("Europe/Rome")
except Exception:
    TZ = None


def fetch(u):
    return urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA}), timeout=40).read().decode("utf-8", "ignore")


def current_giornata():
    h = fetch(BASE)
    m = re.search(r'class="active"\s+href="/serie-a/calendario/(\d+)"', h)
    return int(m.group(1)) if m else None


def match_dates(g):
    """Insieme delle date-partita (YYYY-MM-DD) presenti nella pagina della giornata g.
    NB: la pagina intreccia le date di più giornate → le uso solo come UNIONE."""
    h = fetch(f"{BASE}/{g}")
    return set(re.findall(r'itemprop="startDate"\s+content="(\d{4}-\d{2}-\d{2})"', h))


def decide():
    if os.environ.get("FORCE_RUN") == "1":
        return True, "avvio manuale (forzato)"
    now = datetime.datetime.now(TZ) if TZ else datetime.datetime.utcnow()
    today = now.date().isoformat()
    yesterday = (now.date() - datetime.timedelta(days=1)).isoformat()
    g = current_giornata()
    if not g:
        return False, "giornata corrente non determinata"
    dates = set()
    for gg in (g - 1, g, g + 1):
        if gg >= 1:
            try:
                dates |= match_dates(gg)
            except Exception as e:
                print(f"  g{gg}: errore {e}")
    # una giornata si è chiusa ieri = ieri c'erano partite E oggi non ce ne sono
    run = (yesterday in dates) and (today not in dates)
    return run, f"ieri {yesterday} partite={yesterday in dates} · oggi {today} partite={today in dates} · giornata corrente {g}"


def main():
    run, reason = decide()
    print(("RUN  " if run else "SKIP ") + reason)
    gh = os.environ.get("GITHUB_OUTPUT")
    if gh:
        with open(gh, "a", encoding="utf-8") as f:
            f.write(f"should_run={'true' if run else 'false'}\n")


if __name__ == "__main__":
    main()
