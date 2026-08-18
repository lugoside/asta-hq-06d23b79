# Fonti dati e note di parsing

## Fonte primaria — fantacalcio-online.com (listone + valori) ✅ senza login

URL: `https://www.fantacalcio-online.com/it/serie-a/2026-2027/quotazioni`
(sostituire l'annata quando cambia stagione)

- Pagina HTML server-side (~950 KB, gzip). I dati NON sono in una `<table>`: sono
  in 580 blocchi `<div class="player-element" data-entry>`, uno per giocatore,
  con i valori esposti come `<div data-prop-name="NOME" ...>VALORE</div>`.
- Nessun login necessario per questi dati. (L'export Excel del sito usa JS, ma i
  dati grezzi sono già nel DOM → si parsano con urllib + regex.)
- Attenzione: alcuni script sono avvolti da Cloudflare Rocket Loader
  (`window.__cfRLUnblockHandlers`), ma i `player-element` sono HTML statico.

### Campi utili per giocatore
| data-prop-name       | significato                                   |
|----------------------|-----------------------------------------------|
| `role`               | ruolo CLASSIC: **1=P, 2=D, 4=C, 6=A**         |
| `fieldPositionLabel` | ruolo Mantra (POR, DC, DD, DS, CC, CD, CS, TQ, AC, AS, AD) |
| `firstName`,`lastName`| nome giocatore                               |
| `realteam` → `name`  | squadra (es. Inter, Udinese)                  |
| `kapitals`           | **valore di mercato / quotazione** (Lautaro Martinez=55, top) |
| `overall`            | rating qualità 0–10 (Lautaro=8.70)            |
| `bonus`              | bonus attesi                                  |
| `pot`                | potenziale                                    |
| `lineupRating`       | indicatore di titolarità (~0–3)               |
| `id`, `apiID`        | identificativi                                |
| `birthDate`          | data di nascita                               |

Distribuzione ruoli (2026/27): role 1=69, 2=160, 4=213, 6=138 → 580 giocatori.

### Come interrogarla da Python
```python
html = urllib.request.urlopen(Request(URL, headers={"User-Agent":"Mozilla/5.0",
        "Accept-Encoding":"gzip"})).read()  # gestire gzip
for block in html.split('class="player-element"')[1:]:
    role = prop(block, "role")            # 1/2/4/6
    kap  = prop(block, "kapitals")        # valore
    ...
# prop() = regex  data-prop-name="X"[^>]*>([^<]*)<
```

## Infortunati — fantacalcio-online.com ✅ senza login (tabella statica)

URL: `https://www.fantacalcio-online.com/it/infortunati-serie-a`
Tabella HTML **statica** (parse con `parse_infortunati` in fetch_sources.py):
colonne Squadra | Calciatore ("COGNOME Nome") | Motivo | Rientro previsto | Fonte.
`build_players.annota_infortunati` aggancia per (squadra, nome) → flag `infortunato`,
`rientro`, `motivoInfortunio`. ~28-29 righe tipiche. Guardia: se la tabella non si
trova, la lista è vuota e `meta.numInfortunati` = 0 (segnale che la pagina è cambiata).
NB: gli infortuni NON penalizzano automaticamente il prezzo (per un'asta stagionale
un rientro a set/ott incide poco); sono mostrati come flag, l'utente decide con la manopola.

## Probabili formazioni — SOSFanta (PRIMARIA) ✅, DAZN fallback

**Primaria: SOSFanta** — `https://www.sosfanta.com/asta-fantacalcio/seriea-tutte-formazioni-tipo-...`
Formato testo STABILE: `SQUADRA Formazione-tipo: Por; Dc/Dc, ...; ... . I ballottaggi: ...`.
`parse_formazioni_sos` (rimuove i blocchi <script>/JSON-LD, poi regex) → [{squadra, nome, status}]
con status titolare / ballottaggio (i `/` = ballottaggio). Copre tutte e 20 le squadre.
Toglie le iniziali finali dai nomi (es. "Smolcic I.", "Sucic P").

**Fallback: DAZN** — `.../probabili-formazioni-serie-a-2026-27-...` (heading "Probabile formazione X 2026-27" + tabella).
⚠️ DAZN serve HTML VARIABILE: le 20 `<table>` non sono ancorate ai titoli e le posizioni cambiano
a ogni richiesta → parsing inaffidabile. Usato solo se SOSFanta copre <15 squadre.

`build_players.annota_formazioni` aggancia per **(squadra, token del nome)** — parole in
qualsiasi ordine, senza accenti (gestisce "Lautaro Martínez" ↔ "Martinez Lautaro").
Imposta `formazione` + `titolarita`; `FATTORE_FORMAZIONE` incide sul valore/prezzo
(titolare ×1.0, ballottaggio ×0.9, riserva ×0.7). Guardia: `meta.numFormazioni` basso/0 = fonte cambiata.

NB: la Serie A di questa lega è **Frosinone/Monza/Venezia** + 17 (allineata al listone). `SQUADRE_SERIEA` in fetch_sources.

## Rigoristi e punizioni — Gazzetta ✅ (HTML statico)

URL: `https://www.gazzetta.it/.../rigoristi/17-08-2026/rigoristi-serie-a-...shtml`
⚠️ URL DATATO (17-08): non si auto-aggiorna a un articolo più recente; se Gazzetta ne
pubblica uno nuovo, aggiornare `RIGORISTI_URL`. Per rigori/punizioni pre-asta va bene.
Per ogni squadra (heading): `Calci di rigore: A, B, C` e `Calci di punizione: X, Y` (ordinati).
`parse_rigoristi` → [{squadra, nome, tipo: rigore|punizione, rank}]. `annota_rigoristi` match per
(squadra, token nome), tiene il rank migliore per tipo → `rigoreRank` / `punizioneRank`.
**Corner (assist)**: da SOSFanta `CORNER_URL` — `SQUADRA Punizioni : … Corner : A, B, C`.
`parse_corner` → `cornerRank`. Pesi distinti (rigore gol alta freq > punizione gol rara > corner assist):
`FATTORE_RIGORISTA` (rank1 ×1.10, rank2 ×1.03), `FATTORE_PUNIZIONE` (×1.04), `FATTORE_CORNER` (×1.02).
Guardia: `meta.numRigoristi` / `numPunizioni` / `numCorner`.
Fonte precedente (fallback possibile): `fantacalcio.it/rigoristi-serie-a` — URL stabile che
si auto-aggiorna, ma solo rigori+corner (niente punizioni) e copertura minore.

## Statistiche 2025/26 (presenze, fantamedia, gol, assist, rigori)

NON presenti nella pagina quotazioni sopra (che dà valori/rating, non lo storico).
Opzioni per integrarle (da valutare):
- l'`overall`/`bonus`/`lineupRating` della fonte primaria sono già un proxy di
  rendimento/titolarità → sufficienti per una prima valutazione basata sul mercato.
- fonti storico da verificare: fantacalcio-online sezione statistiche, sosfanta,
  pianetafanta (SPA JS, richiede rendering), o export Excel ufficiale (login).

## Fonti scartate
- `pianetafanta.it/giocatori-quotazioni.asp`: dati caricati via JS (SPA), niente
  `<table>` server-side → richiederebbe browser headless.
- API `fantagoat`/`FSTATS`: risultavano dismesse.
