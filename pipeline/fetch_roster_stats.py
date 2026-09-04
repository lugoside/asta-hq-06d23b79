#!/usr/bin/env python3
"""
fetch_roster_stats.py — statistiche RICCHE della MIA rosa (FULL, personale).

Scarica SOLO le pagine-giocatore dei ~25 fantaId elencati in my_roster_ids.json
(fonte pubblica fantacalcio.it, nessun login) ed estrae dati NON presenti nella
pagina /statistiche-serie-a:
  - Titolare (presenze da titolare + %) / Entrato (subentri + %)
  - Gol casa/trasferta  (o Gol subiti casa/trasferta per i portieri)
  - Autoreti · Ammonizioni · Espulsioni
  - Rigori segnati/totali (o Rigori parati) · Assist · Gol/Gol subiti · MV · FM

L'URL della pagina-giocatore serve lo slug: lo raccolgo dalle righe di
/statistiche-serie-a (mappa fantaId -> url), poi scarico solo i miei.

Output: fonde in docs/data/giornata.json la chiave "detail" = { fantaId: {...} }.
Lo scrape è MIRATO (25 pagine) → leggero. NON tocca "stats" (usata dal Listone).

Uso:  python fetch_roster_stats.py
"""
import urllib.request, re, json, os, time, html as ihtml
from urllib.parse import quote


def clean_url(raw):
    """Decodifica le entità HTML nell'href (es. cal&#xF2; → calò) e ri-encoda i
    caratteri non-ASCII (ò → %C3%B2), altrimenti urllib scarica un URL malformato."""
    return quote(ihtml.unescape(raw), safe="/:?=&%#")

HERE = os.path.dirname(os.path.abspath(__file__))
GIORNATA = os.path.join(HERE, "..", "docs", "data", "giornata.json")
ROSTER = os.path.join(HERE, "my_roster_ids.json")
UA = "Mozilla/5.0"
STATS_URL = "https://www.fantacalcio.it/statistiche-serie-a"


def fetch(u):
    return urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA}), timeout=40).read().decode("utf-8", "ignore")


def num(s):
    s = (s or "").strip().replace(",", ".")
    try:
        return float(s) if "." in s else int(s)
    except ValueError:
        return 0


def split_pair(s, sep="/"):
    """'3/2' -> (3, 2);  '2 - 100' -> (2, 100)."""
    parts = re.split(re.escape(sep) if sep != "-" else r"\s*-\s*", s or "")
    a = num(parts[0]) if parts and parts[0].strip() != "" else 0
    b = num(parts[1]) if len(parts) > 1 else 0
    return a, b


def id_to_url_map():
    h = fetch(STATS_URL)
    m = {}
    for r in re.findall(r'<tr class="player-row".*?</tr>', h, re.S):
        u = re.search(r'href="(https://www\.fantacalcio\.it/serie-a/squadre/[^"]+/(\d+))"', r)
        if u:
            m[u.group(2)] = clean_url(u.group(1))
    return m


def parse_player(h):
    # PropertyValue: <th name description>LABEL</th><td class="value">…</td>
    # il valore può stare in <span class="pill">VAL</span> OPPURE diretto nel <td>VAL</td>
    pv = {}
    for m in re.finditer(r'itemprop="name description">([^<]+)</th>\s*<td[^>]*class="value">\s*(?:<span[^>]*class="pill">([^<]*)</span>|([^<]*))', h):
        label = ihtml.unescape(m.group(1)).strip()
        val = (m.group(2) if m.group(2) is not None else (m.group(3) or "")).strip()
        pv[label] = val
    # badge stato presenza: <span name description>Titolare</span><strong><span value>2 - 100</span>
    bd = {}
    for label, val in re.findall(r'itemprop="name description">([^<]+)</span>\s*<strong[^>]*>\s*<span itemprop="value">([^<]*)</span>', h):
        bd[ihtml.unescape(label).strip()] = val.strip()
    # media: <span class="badge ... avg">8,25</span> <span class="small-label">MV</span> ; idem FM
    mvfm = dict((k, num(v)) for v, k in re.findall(r'class="badge[^"]*avg">([0-9.,\-]+)</span>\s*<span class="small-label">(MV|FM)</span>', h))

    golC, golT = split_pair(pv.get("Gol casa/trasferta", ""))
    gsC, gsT = split_pair(pv.get("Gol subiti casa/trasferta", ""))
    rigSeg, rigTot = split_pair(pv.get("Rigori segnati/totali", ""))
    tit, titPerc = split_pair(bd.get("Titolare", ""), "-")
    sub, subPerc = split_pair(bd.get("Entrato", ""), "-")
    squal, _ = split_pair(bd.get("Squalificato", ""), "-")
    inf, _ = split_pair(bd.get("Infortunato", ""), "-")
    inut, _ = split_pair(bd.get("Inutilizzato", ""), "-")

    return {
        "pgv": num(pv.get("Partite a voto")),          # partite a voto
        "gol": num(pv.get("Gol")), "gs": num(pv.get("Gol subiti")),
        "ass": num(pv.get("Assist")),
        "golCasa": golC, "golTras": golT,              # split gol fatti
        "gsCasa": gsC, "gsTras": gsT,                  # split gol subiti (portiere)
        "autogol": num(pv.get("Autoreti")),
        "amm": num(pv.get("Ammonizioni")), "esp": num(pv.get("Espulsioni")),
        "rigSeg": rigSeg, "rigTot": rigTot,            # rigori segnati / calciati
        "rp": num(pv.get("Rigori parati")),            # rigori parati (portiere)
        "tit": tit, "titPerc": titPerc,                # presenze da titolare + %
        "sub": sub, "subPerc": subPerc,                # subentri + %
        "squal": squal, "inf": inf, "inut": inut,
        "mv": mvfm.get("MV", 0), "fm": mvfm.get("FM", 0),
    }


def main():
    roster = json.load(open(ROSTER, encoding="utf-8"))["roster"]
    urls = id_to_url_map()
    scraped, miss, err = {}, [], []
    for i, p in enumerate(roster):
        fid = str(p["fantaId"])
        url = urls.get(fid)
        if not url:
            miss.append(p["nome"]); continue
        try:
            scraped[fid] = parse_player(fetch(url))
        except Exception as e:
            err.append(f"{p['nome']}: {e}")
        time.sleep(0.35)  # gentile con il sito
    # FONDE nel detail esistente senza clobberare le chiavi di altri scraper (es. "match"
    # aggiunto da fetch_matches.py) → i due scraper sono indipendenti dall'ordine.
    data = json.load(open(GIORNATA, encoding="utf-8")) if os.path.exists(GIORNATA) else {}
    detail = data.setdefault("detail", {})
    for fid, parsed in scraped.items():
        detail.setdefault(fid, {}).update(parsed)
    data["numDetail"] = len(scraped)
    json.dump(data, open(GIORNATA, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"detail scritto in giornata.json: {len(scraped)}/{len(roster)} giocatori")
    if miss:
        print("  senza URL:", ", ".join(miss))
    if err:
        print("  errori:", "; ".join(err))
    # anteprima
    for fid, d in list(scraped.items())[:3]:
        print(f"  {fid}: tit {d['tit']}({d['titPerc']}%) sub {d['sub']} | gol {d['gol']} casa/tras {d['golCasa']}/{d['golTras']} | mv {d['mv']} fm {d['fm']}")


if __name__ == "__main__":
    main()
