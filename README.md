# FantaAsta Assistant

Assistente **live** per l'asta del fantacalcio (Classic). Durante l'asta inserisci chi viene comprato e a quanto; l'app ricalcola in tempo reale il **prezzo consigliato** per ogni giocatore chiamato, tenendo conto di inflazione, scarsità di ruolo e del tuo budget residuo.

- **Lega**: 10 squadre × 500 crediti (montepremi 5000). Rosa 3-8-8-6 (25 giocatori).
- **Asta**: 3 settembre 2026 — stagione 2026/27.

## Architettura

- `pipeline/` — script Python che reperiscono e normalizzano i dati (listone 2026/27 + statistiche 2025/26) → `docs/data/players.json`.
- `docs/` — la **PWA** (web app installabile), pubblicata via GitHub Pages. Vanilla JS, nessun build step.
- `.github/workflows/update-data.yml` — rigenera i dati (schedulato + avviabile a mano dal telefono).
- `tests/` — test del modello di valore (Python) e del motore di prezzo (Node).

## Uso in locale

```bash
# rigenerare i dati
cd pipeline && pip install -r requirements.txt && python build_players.py

# anteprima app
cd docs && python -m http.server 8000   # apri http://localhost:8000

# test
node tests/test_engine.mjs
python -m pytest tests/test_valuation.py
```

## Aggiornare i dati dal telefono (prima dell'asta)

GitHub → Actions → *update-data* → **Run workflow**. Poi in app tocca **🔄 Aggiorna dati**.
