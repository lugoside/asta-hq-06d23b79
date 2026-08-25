#!/usr/bin/env python3
"""
fetch_indisponibili.py — seconda fonte infortuni dalla pagina PUBBLICA
https://www.fantacalcio.it/indisponibili-serie-a . Estrae, per ogni club, SOLO la
sezione "Infortunati" (ignora Squalificati/Diffidati) → raw/indisponibili.json.
Serve a COPRIRE i buchi di raw/infortunati.json (fantacalcio-online): es. Yildiz
compare qui ma non lì. Le descrizioni sono in prosa: la data di rientro si estrae
solo se presente in forma numerica (gg/mm), altrimenti resta vuota (→ malus di
default basso in build_players).

SICUREZZA: se lo scrape fallisce o trova < MIN_TEAMS club, NON sovrascrive il file
esistente (resta l'ultima versione valida).

Uso:  python fetch_indisponibili.py [url]
Output: pipeline/raw/indisponibili.json
"""
import urllib.request, re, json, os, sys, html as ihtml

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "raw", "indisponibili.json")
URL = "https://www.fantacalcio.it/indisponibili-serie-a"
MIN_TEAMS = 15  # sotto questa soglia lo scrape è considerato fallito


def fetch_html(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=40).read().decode("utf-8", "ignore")


def parse(html: str) -> list[dict]:
    out = []
    # blocchi per squadra: <span class="team-name">TEAM</span> ... fino al prossimo
    parts = re.split(r'<span class="team-name">', html)[1:]
    teams_seen = set()
    for part in parts:
        tm = re.match(r'\s*([^<]+?)\s*</span>', part)
        if not tm:
            continue
        team = ihtml.unescape(tm.group(1)).strip()
        # isola la sezione "Infortunati": la prima <ul class="unstyled"> dopo l'etichetta
        im = re.search(r'Infortunati\s*</strong>.*?<ul class="unstyled">(.*?)</ul>', part, re.S)
        if not im:
            continue
        teams_seen.add(team)
        for li in re.findall(r'<li>(.*?)</li>', im.group(1), re.S):
            nm = re.search(r'item-name">([^<]+)</strong>', li)
            if not nm:
                continue
            nome = ihtml.unescape(nm.group(1)).strip()
            desc = re.sub(r'<[^>]+>', ' ', li)
            desc = re.sub(r'\s+', ' ', ihtml.unescape(desc)).strip()
            dm = re.search(r'\b(\d{1,2}/\d{1,2}(?:/\d{4})?)\b', desc)  # data solo se numerica
            out.append({
                "squadra": team,
                "nome": nome,
                "motivo": desc[:180],
                "rientro": dm.group(1) if dm else "",
                "fonte": "fantacalcio.it/indisponibili",
            })
    return out, len(teams_seen)


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else URL
    try:
        data, nteams = parse(fetch_html(url))
    except Exception as e:
        print(f"ATTENZIONE: scrape indisponibili fallito ({e}). File invariato.")
        return 1
    if nteams < MIN_TEAMS:
        print(f"ATTENZIONE: solo {nteams} club con sezione Infortunati (< {MIN_TEAMS}). "
              f"Struttura forse cambiata: file NON sovrascritto.")
        return 1
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    con_data = sum(1 for x in data if x["rientro"])
    print(f"OK: {len(data)} infortunati da {nteams} club -> {OUT}  (con data numerica: {con_data})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
