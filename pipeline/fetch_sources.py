"""fetch_sources.py — scarica il listone ufficiale 2026/27 da fantacalcio-online.com
e lo salva grezzo in pipeline/raw/listone.json (schema dell'app).

Vedi pipeline/sources.md per la struttura della pagina. Nessun login richiesto.

Uso:  python fetch_sources.py            # stagione di default
      python fetch_sources.py 2026-2027
"""
from __future__ import annotations
import gzip
import html as ihtml
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RAW_DIR = os.path.join(HERE, "raw")
STAGIONE_DEFAULT = "2026-2027"
URL_TMPL = "https://www.fantacalcio-online.com/it/serie-a/{stag}/quotazioni"
INFORTUNATI_URL = "https://www.fantacalcio-online.com/it/infortunati-serie-a"
FORMAZIONI_URL = "https://www.dazn.com/it-IT/news/calcio/probabili-formazioni-serie-a-2026-27-titolari-moduli-e-ballottaggi-di-tutte-le-squadre/sxqiznnb92qk1ugq242gra6tp"
# SOSFanta copre anche le neopromosse (che DAZN non ha)
FORMAZIONI_SOS_URL = "https://www.sosfanta.com/asta-fantacalcio/seriea-tutte-formazioni-tipo-fantacalcio-2026-2027-asta-consigli-chi-prendere/?refresh_ce"
# Gazzetta: per ogni squadra 'Calci di rigore: ...' e 'Calci di punizione: ...' (ordinati)
RIGORISTI_URL = "https://www.gazzetta.it/calcio/fantanews/strumenti-fantacalcio/rigoristi/17-08-2026/rigoristi-serie-a-fantacalcio-tiratori-calci-da-fermo-punizioni.shtml"
# DAZN copre tutte e 20 le squadre; SOSFanta resta come fallback (vuoto = disattivo)
NEOPROMOSSE = []
SQUADRE_SERIEA = [
    "Atalanta", "Bologna", "Cagliari", "Como", "Fiorentina", "Frosinone",
    "Genoa", "Inter", "Juventus", "Lazio", "Lecce", "Milan", "Monza",
    "Napoli", "Parma", "Roma", "Sassuolo", "Torino", "Udinese", "Venezia",
]

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


def parse_data_fonte(html: str) -> str | None:
    """Estrae la data di aggiornamento dichiarata dalla fonte (es. 'aggiornata al 18/08/2026')."""
    m = re.search(r'aggiornat[ae]\s+al\s+(\d{1,2}/\d{1,2}/\d{2,4})', html, re.I)
    return m.group(1) if m else None


def parse_infortunati(html: str) -> list[dict]:
    """Estrae la tabella infortunati (statica) → lista di dict.
    Colonne attese: Squadra | Calciatore | Motivo | Rientro previsto | Fonte.
    """
    m = re.search(r"<table.*?</table>", html, re.S | re.I)
    if not m:
        return []
    out = []
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", m.group(0), re.S | re.I):
        cells = [re.sub(r"\s+", " ", ihtml.unescape(re.sub(r"<[^>]+>", " ", c))).strip()
                 for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.S | re.I)]
        if len(cells) < 4 or cells[0].lower() == "squadra":
            continue
        out.append({
            "squadra": cells[0], "nome": cells[1], "motivo": cells[2],
            "rientro": cells[3] if len(cells) > 3 else "",
            "fonte": cells[4] if len(cells) > 4 else "",
        })
    return out


def _clean_txt(s: str) -> str:
    return re.sub(r"\s+", " ", ihtml.unescape(re.sub(r"<[^>]+>", " ", s))).strip()


def _parse_formazione_table(table_html: str, team: str) -> list[dict]:
    """Legge le celle di una tabella-formazione: 'Titolare (Ris - Ris2)' / 'A / B (Ris)'."""
    out = []
    for cell in re.findall(r"<td[^>]*>(.*?)</td>", table_html, re.S | re.I):
        txt = _clean_txt(cell)
        if not txt:
            continue
        mm = re.match(r"^(.*?)\s*\((.*)\)\s*$", txt)
        before, paren = (mm.group(1), mm.group(2)) if mm else (txt, "")
        starters = [x.strip() for x in before.split("/") if x.strip()]
        status = "ballottaggio" if len(starters) > 1 else "titolare"
        for s in starters:
            out.append({"squadra": team, "nome": s, "status": status})
        for r in re.split(r"[-/]", paren):
            r = r.strip()
            if r:
                out.append({"squadra": team, "nome": r, "status": "riserva"})
    return out


def parse_formazioni(html: str) -> list[dict]:
    """Estrae le formazioni-tipo da DAZN. La pagina ha un INDICE con gli stessi titoli
    'Probabile formazione X 2026-27': prendiamo l'occorrenza (quella del contenuto)
    seguita da una tabella entro ~3000 char senza altri titoli-squadra in mezzo.
    """
    out = []
    for team in SQUADRE_SERIEA:
        needle = f"Probabile formazione {team} 2026-27"
        # tra le occorrenze del titolo, quella del CONTENUTO è l'unica con una
        # tabella subito dopo (entro ~1500 char); le altre sono menzioni nel testo.
        for mm in re.finditer(re.escape(needle), html):
            mt = re.search(r"<table.*?</table>", html[mm.end(): mm.end() + 1500], re.S | re.I)
            if mt:
                out.extend(_parse_formazione_table(mt.group(0), team))
                break
    return out


def parse_formazioni_sos(html: str, teams: list[str]) -> list[dict]:
    """Formazioni-tipo da SOSFanta per squadre selezionate (es. neopromosse).
    Formato testo: 'SQUADRA Formazione-tipo: Por; Dc/Dc, ...; ... . I ballottaggi: ...'
    """
    # via i blocchi <script> (JSON-LD) che contengono una copia troncata dell'articolo
    html = re.sub(r"<script.*?</script>", " ", html, flags=re.S | re.I)
    text = _clean_txt(html)
    out = []
    for team in teams:
        pats = ["Hellas Verona", "Verona"] if team == "Verona" else [team]
        m = None
        for pt in pats:
            m = re.search(re.escape(pt) + r"\s+Formazione-tipo:\s*(.*?)\s+I ballottaggi", text, re.I | re.S)
            if m:
                break
        if not m:
            continue
        for slot in re.split(r"[;,]", m.group(1)):
            slot = slot.strip().strip(".")
            if not slot:
                continue
            names = []
            for nm in slot.split("/"):
                nm = re.sub(r"\s+[A-Za-zÀ-ü]{1,2}\.?$", "", nm.strip()).strip()  # toglie l'iniziale finale (es. "Smolcic I.", "Sucic P")
                if nm:
                    names.append(nm)
            if not names:
                continue
            status = "ballottaggio" if len(names) > 1 else "titolare"
            for nm in names:
                out.append({"squadra": team, "nome": nm, "status": status})
    return out


def parse_rigoristi(html: str) -> list[dict]:
    """Rigoristi e battitori di punizione da Gazzetta. Per ogni squadra (heading):
    'Calci di rigore: A, B, C' e 'Calci di punizione: X, Y' (ordinati).
    Ritorna [{squadra, nome, tipo: rigore|punizione, rank}] (rank 1 = principale).
    """
    html = re.sub(r"<script.*?</script>", " ", html, flags=re.S | re.I)
    headings = [(m.start(), m.end(), _clean_txt(m.group(1)).strip())
                for m in re.finditer(r"<h[2-4][^>]*>(.*?)</h[2-4]>", html, re.S | re.I)]
    out = []
    for i, (s, e, team) in enumerate(headings):
        if team not in SQUADRE_SERIEA:
            continue
        end = headings[i + 1][0] if i + 1 < len(headings) else len(html)
        block = _clean_txt(html[e:end])
        for tipo, label in (("rigore", "Calci di rigore"), ("punizione", "Calci di punizione")):
            mm = re.search(label + r":\s*(.*?)(?:\s*Calci di (?:rigore|punizione):|\.|$)", block, re.I)
            if not mm:
                continue
            names = [n.strip() for n in re.split(r"[,;]| e ", mm.group(1)) if n.strip()]
            for rank, nm in enumerate(names, 1):
                out.append({"squadra": team, "nome": nm, "tipo": tipo, "rank": rank})
    return out


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
    data_fonte = parse_data_fonte(html)
    os.makedirs(RAW_DIR, exist_ok=True)
    out = os.path.join(RAW_DIR, "listone.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(players, f, ensure_ascii=False)
    # sidecar con i metadati della fonte (data di aggiornamento del listone)
    with open(os.path.join(RAW_DIR, "source_meta.json"), "w", encoding="utf-8") as f:
        json.dump({"fonteAggiornata": data_fonte, "url": url}, f, ensure_ascii=False)
    # infortunati (tabella statica separata)
    try:
        inf = parse_infortunati(fetch_html(INFORTUNATI_URL))
    except Exception as e:
        inf = []
        print("Attenzione: infortunati non letti:", e)
    with open(os.path.join(RAW_DIR, "infortunati.json"), "w", encoding="utf-8") as f:
        json.dump(inf, f, ensure_ascii=False)

    # probabili formazioni (DAZN)
    # Formazioni: SOSFanta è la PRIMARIA (formato testo stabile, tutte le squadre).
    # DAZN resta come fallback (contenuto corretto ma HTML variabile → parsing inaffidabile).
    try:
        form = parse_formazioni_sos(fetch_html(FORMAZIONI_SOS_URL), SQUADRE_SERIEA)
    except Exception as e:
        form = []
        print("Attenzione: formazioni SOS non lette:", e)
    if len({x["squadra"] for x in form}) < 15:
        try:
            dazn = parse_formazioni(fetch_html(FORMAZIONI_URL))
            if len({x["squadra"] for x in dazn}) > len({x["squadra"] for x in form}):
                form = dazn
                print("Uso il fallback DAZN per le formazioni")
        except Exception as e:
            print("Attenzione: fallback DAZN non letto:", e)
    with open(os.path.join(RAW_DIR, "formazioni.json"), "w", encoding="utf-8") as f:
        json.dump(form, f, ensure_ascii=False)

    # rigoristi (fantacalcio.it)
    try:
        rig = parse_rigoristi(fetch_html(RIGORISTI_URL))
    except Exception as e:
        rig = []
        print("Attenzione: rigoristi non letti:", e)
    with open(os.path.join(RAW_DIR, "rigoristi.json"), "w", encoding="utf-8") as f:
        json.dump(rig, f, ensure_ascii=False)
    print(f"Rigoristi letti: {len(rig)}")

    from collections import Counter
    print(f"OK: {len(players)} giocatori -> {out}")
    print(f"Listone aggiornato dalla fonte al: {data_fonte or 'n/d'}")
    print(f"Infortunati letti: {len(inf)}")
    print(f"Voci formazioni lette: {len(form)}")
    print("Per ruolo:", dict(Counter(p["ruolo"] for p in players)))
    top = sorted(players, key=lambda p: -p["qi"])[:6]
    print("Top per valore:", ", ".join(f"{p['nome']}({p['qi']})" for p in top))


if __name__ == "__main__":
    main()
