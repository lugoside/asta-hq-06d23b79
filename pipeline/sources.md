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
