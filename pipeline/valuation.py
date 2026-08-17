"""valuation.py — modello di VALORE di un giocatore per il fantacalcio.

Il "valore base" stima quanti punti-fanta un giocatore produce in una stagione
*al di sopra di un giocatore da riserva* nel suo ruolo (Value Over Replacement):

    valore = presenze_attese * (fantamedia_proiettata - soglia_ruolo) + bonus

- presenze_attese: quanto giocherà davvero (affidabilità/titolarità). Pesa molto:
  un fenomeno che gioca 12 partite vale meno di un buon titolare che ne gioca 34.
- fantamedia_proiettata: la fantamedia dell'anno scorso "regolarizzata" verso la
  media del ruolo (shrinkage), per non fidarsi ciecamente di poche partite.
- soglia_ruolo: la fantamedia di un titolare "da riserva"; così contano i
  DIFFERENZIALI, non la media grezza (tutti i portieri fanno ~6).
- bonus: premio per i rigoristi (valore predittivo forte, soprattutto C/A).

Casi senza storico (neopromosse, acquisti esteri): il valore è stimato dalla
quotazione iniziale ufficiale (Qi), che il mercato usa proprio come proxy.

Tutti i parametri sono COSTANTI in testa al file, facili da tarare.
"""
from __future__ import annotations
from dataclasses import dataclass, asdict

# --- parametri tarabili -----------------------------------------------------
GIORNATE = 38  # partite di Serie A in una stagione

# fantamedia "da riserva" per ruolo: sopra questa soglia il giocatore crea valore
SOGLIA_RUOLO = {"P": 5.8, "D": 5.9, "C": 6.0, "A": 6.2}

# prior di fantamedia verso cui regredire (≈ soglia: un ignoto vale come riserva)
PRIOR_FM = {"P": 5.9, "D": 6.0, "C": 6.1, "A": 6.3}
SHRINKAGE_K = 6.0  # "partite equivalenti" di prior: più alto = più prudente

# premio rigorista (punti-fanta stagionali aggiuntivi stimati)
BONUS_RIGORISTA = {"P": 0.0, "D": 6.0, "C": 8.0, "A": 6.0}

# stima titolarità di default dai dati (se non fornita esplicitamente)
TIT_MIN, TIT_MAX = 0.12, 0.98
PRESENZE_PER_TITOLARE = 32.0  # ~presenze di un titolare pieno

# fallback da quotazione (Qi) per chi non ha storico affidabile
QI_REPLACEMENT = {"P": 3, "D": 3, "C": 5, "A": 8}  # Qi ~ da riserva per ruolo
# quanti punti di valore per credito di Qi sopra la soglia.
# NB: valore di default prudente; build_players.py lo RICALIBRA sui dati reali
# (allineando la mediana del valore-da-Qi a quella del valore-da-statistiche).
QI_SCALE = 2.5
MIN_PRESENZE_AFFIDABILI = 5  # sotto questo usiamo il fallback Qi


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def stima_titolarita(presenze: int) -> float:
    """Stima grezza della probabilità di titolarità dalle presenze dell'anno scorso."""
    return clamp(presenze / PRESENZE_PER_TITOLARE, TIT_MIN, TIT_MAX)


def presenze_attese(titolarita: float) -> float:
    return GIORNATE * titolarita


def fantamedia_proiettata(fm: float, presenze: int, ruolo: str) -> float:
    """Shrinkage bayesiano verso il prior di ruolo (poche partite → poca fiducia)."""
    prior = PRIOR_FM[ruolo]
    return (fm * presenze + prior * SHRINKAGE_K) / (presenze + SHRINKAGE_K)


def valore_da_qi(qi: float, ruolo: str) -> float:
    """Valore stimato dalla sola quotazione ufficiale (per chi non ha storico)."""
    return max(0.0, (qi - QI_REPLACEMENT[ruolo]) * QI_SCALE)


# --- valutazione basata sul MERCATO (fonte reale con kapitals/overall) ------
# Il valore di mercato (kapitals) incorpora già l'expertise della community;
# lo usiamo come base, con una lieve inclinazione per il rating "overall".
OVERALL_MID = 6.0  # rating "medio"; sopra alza, sotto abbassa

def valore_da_mercato(qi: float, overall: float, ruolo: str) -> float:
    base = max(0.0, qi - QI_REPLACEMENT[ruolo])  # valore sopra la riserva del ruolo
    tilt = clamp(1.0 + 0.10 * (overall - OVERALL_MID), 0.7, 1.4) if overall else 1.0
    return round(base * tilt, 2)


def valuta_lista_mercato(players: list[dict]) -> list[dict]:
    """Valuta con il modello di MERCATO i record che hanno kapitals/overall.

    Aggiunge valoreBase e (per trasparenza) fmProiettata≈overall, presenzeAttese
    e titolarita stimate da lineupRating (0..3 → 0..1).
    """
    for p in players:
        overall = float(p.get("overall", 0) or 0)
        qi = float(p.get("qi", 1) or 1)
        p["valoreBase"] = valore_da_mercato(qi, overall, p.get("ruolo", "C"))
        lr = float(p.get("lineupRating", 0) or 0)
        p["titolarita"] = round(clamp(lr / 3.0, TIT_MIN, TIT_MAX), 3) if lr else round(clamp(qi / 30.0, TIT_MIN, TIT_MAX), 3)
        p["fmProiettata"] = round(overall, 2) if overall else None
        p["presenzeAttese"] = round(GIORNATE * p["titolarita"], 1)
        p["fonteValore"] = "mercato"
    return players


@dataclass
class Valutazione:
    valoreBase: float
    fmProiettata: float
    presenzeAttese: float
    titolarita: float
    fonte: str  # "stats" | "qi" | "blend"


def valuta_giocatore(
    ruolo: str,
    *,
    presenze: int = 0,
    fm: float = 0.0,
    gol: int = 0,
    assist: int = 0,
    rig_calciati: int = 0,
    qi: float = 1,
    titolarita: float | None = None,
    is_nuovo: bool = False,
) -> Valutazione:
    """Ritorna la valutazione completa di un giocatore.

    `titolarita` esplicita (0..1) ha priorità; altrimenti stimata dalle presenze.
    """
    ruolo = ruolo.upper()[0]
    if ruolo not in SOGLIA_RUOLO:
        ruolo = "C"

    tit = titolarita if titolarita is not None else stima_titolarita(presenze)
    pa = presenze_attese(tit)

    fmp = fantamedia_proiettata(fm, presenze, ruolo)
    vor = pa * (fmp - SOGLIA_RUOLO[ruolo])

    # premio rigorista (solo se calcia rigori con continuità)
    bonus = BONUS_RIGORISTA[ruolo] if rig_calciati >= 3 else 0.0
    valore_stats = vor + bonus

    # fallback / blend con la quotazione per chi ha pochi dati
    valore_qi = valore_da_qi(qi, ruolo)
    if is_nuovo or presenze < MIN_PRESENZE_AFFIDABILI:
        # peso crescente sullo storico man mano che le presenze aumentano
        w = clamp(presenze / MIN_PRESENZE_AFFIDABILI, 0.0, 1.0)
        valore = w * valore_stats + (1 - w) * valore_qi
        fonte = "qi" if w == 0 else "blend"
    else:
        valore = valore_stats
        fonte = "stats"

    return Valutazione(
        valoreBase=round(valore, 2),
        fmProiettata=round(fmp, 3),
        presenzeAttese=round(pa, 1),
        titolarita=round(tit, 3),
        fonte=fonte,
    )


def valuta_lista(players: list[dict]) -> list[dict]:
    """Applica la valutazione a una lista di record giocatore (in-place, ritorna la lista).

    Ogni record atteso: { ruolo, qi, isNuovo?, titolarita?, stats2526:{presenze,fm,gol,assist,rigCalciati} }.
    Aggiunge i campi valoreBase / fmProiettata / presenzeAttese / titolarita / fonteValore.
    """
    for p in players:
        s = p.get("stats2526", {}) or {}
        v = valuta_giocatore(
            p.get("ruolo", "C"),
            presenze=int(s.get("presenze", 0) or 0),
            fm=float(s.get("fm", 0) or 0),
            gol=int(s.get("gol", 0) or 0),
            assist=int(s.get("assist", 0) or 0),
            rig_calciati=int(s.get("rigCalciati", 0) or 0),
            qi=float(p.get("qi", 1) or 1),
            titolarita=p.get("titolarita"),
            is_nuovo=bool(p.get("isNuovo", False)),
        )
        p["valoreBase"] = v.valoreBase
        p["fmProiettata"] = v.fmProiettata
        p["presenzeAttese"] = v.presenzeAttese
        p["titolarita"] = v.titolarita
        p["fonteValore"] = v.fonte
    return players


if __name__ == "__main__":
    # esempio rapido
    esempi = [
        ("A", dict(presenze=36, fm=8.4, gol=22, assist=6, rig_calciati=7, qi=35)),  # bomber rigorista
        ("A", dict(presenze=11, fm=8.0, gol=6, assist=1, qi=18)),                    # talento poco impiegato
        ("C", dict(presenze=35, fm=6.9, gol=8, assist=9, rig_calciati=0, qi=22)),
        ("D", dict(presenze=34, fm=6.1, gol=2, assist=3, qi=12)),
        ("P", dict(presenze=38, fm=6.3, qi=18)),
        ("A", dict(presenze=0, fm=0, qi=25, is_nuovo=True)),                          # nuovo acquisto estero
    ]
    for ruolo, kw in esempi:
        print(ruolo, kw, "→", valuta_giocatore(ruolo, **kw))
