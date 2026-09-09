#!/usr/bin/env python3
"""
should_run_probabili.py — GATE per i run "probabili formazioni" (frequenti, avvicinamento).

Vogliamo catturare i probabili aggiornati prima di schierare la formazione:
  - il GIORNO PRIMA della 1ª partita del turno -> ogni ~3 ore (09-21 IT)
  - il GIORNO della 1ª partita -> ogni ~2 ore, fino a ~1-2 ore prima del calcio d'inizio
    (ultima run all'ora intera compresa fra 1h e 2h prima del kickoff)
  - TUTTI GLI ALTRI GIORNI (metà settimana) -> 3 refresh/giorno (09/13/18), così le
    probabili che si muovono a inizio settimana (es. un titolare promosso) non restano ferme

Il kickoff della 1ª gara del turno si legge dal CALENDARIO della giornata attiva
(data + ora di ogni match -> il minimo). Fuso Europe/Rome.

Scrive should_run=true|false su $GITHUB_OUTPUT. FORCE_RUN=1 -> sempre true (avvio manuale).
Uso locale:  python should_run_probabili.py
"""
import urllib.request, re, os, datetime

UA = "Mozilla/5.0"
BASE = "https://www.fantacalcio.it/serie-a/calendario"
try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("Europe/Rome")
except Exception:
    TZ = None

DAY_BEFORE_HOURS = (9, 12, 15, 18, 21)   # giorno prima: ogni 3h
OTHER_DAYS_HOURS = (9, 13, 18)           # altri giorni (fuori avvicinamento): 3 refresh/giorno


def fetch(u):
    return urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA}), timeout=40).read().decode("utf-8", "ignore")


def first_kickoff():
    """datetime (Europe/Rome) della 1ª partita della giornata attiva, o None."""
    h = fetch(BASE)
    m = re.search(r'class="active"\s+href="/serie-a/calendario/(\d+)"', h)
    if not m:
        return None
    c = fetch(f"{BASE}/{m.group(1)}")
    dts = []
    for date_s, hh, mm in re.findall(
        r'startDate"\s+content="(\d{4}-\d{2}-\d{2})"\s*/>\s*<span class="day">[^<]*</span>\s*<span class="hours">\s*(\d{1,2})[:.](\d{2})',
        c):
        y, mo, da = map(int, date_s.split("-"))
        dts.append(datetime.datetime(y, mo, da, int(hh), int(mm), tzinfo=TZ))
    return min(dts) if dts else None


def decide():
    if os.environ.get("FORCE_RUN") == "1":
        return True, "avvio manuale (forzato)"
    ko = first_kickoff()
    if not ko:
        return False, "kickoff non determinato"
    now = datetime.datetime.now(TZ) if TZ else datetime.datetime.now()
    day_before = ko.date() - datetime.timedelta(days=1)
    if now.date() == day_before:
        run = now.hour in DAY_BEFORE_HOURS
        return run, f"giorno prima ({day_before}) ora {now.hour} -> {'RUN' if run else 'skip'}"
    if now.date() == ko.date() and now < ko:
        last = (ko - datetime.timedelta(hours=1)).hour   # ultima slot: ora intera 1-2h prima del kickoff
        slots = set(range(last, 8, -2))                  # last, last-2, … (>=9)
        run = now.hour in slots
        return run, f"giorno gara ora {now.hour}, kickoff {ko.strftime('%H:%M')}, ultima slot {last} -> {'RUN' if run else 'skip'}"
    # tutti gli altri giorni (metà settimana, o giorno-gara dopo il kickoff): 2 refresh/giorno
    run = now.hour in OTHER_DAYS_HOURS
    return run, f"altri giorni (kickoff {ko.isoformat()}) ora {now.hour} -> {'RUN' if run else 'skip'}"


def main():
    run, reason = decide()
    print(("RUN  " if run else "SKIP ") + reason)
    gh = os.environ.get("GITHUB_OUTPUT")
    if gh:
        with open(gh, "a", encoding="utf-8") as f:
            f.write(f"should_run={'true' if run else 'false'}\n")


if __name__ == "__main__":
    main()
