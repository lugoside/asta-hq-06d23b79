"""Test del modello di valore. Esegui con:  python -m pytest tests/test_valuation.py -q
(oppure:  python tests/test_valuation.py)
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "pipeline"))

from valuation import (  # noqa: E402
    valuta_giocatore,
    fantamedia_proiettata,
    stima_titolarita,
    valuta_lista,
    SOGLIA_RUOLO,
)


def test_bomber_vale_piu_del_talento_poco_impiegato():
    bomber = valuta_giocatore("A", presenze=36, fm=8.4, gol=22, assist=6, rig_calciati=7, qi=35)
    talento = valuta_giocatore("A", presenze=11, fm=8.0, gol=6, assist=1, qi=18)
    # stessa qualità media, ma il bomber gioca molto di più → vale molto di più
    assert bomber.valoreBase > 2 * talento.valoreBase


def test_valore_cresce_con_le_presenze():
    poche = valuta_giocatore("C", presenze=15, fm=6.6, qi=15).valoreBase
    tante = valuta_giocatore("C", presenze=34, fm=6.6, qi=15).valoreBase
    assert tante > poche


def test_valore_cresce_con_la_fantamedia():
    bassa = valuta_giocatore("C", presenze=34, fm=6.2, qi=15).valoreBase
    alta = valuta_giocatore("C", presenze=34, fm=7.2, qi=15).valoreBase
    assert alta > bassa


def test_rigorista_premiato():
    senza = valuta_giocatore("A", presenze=34, fm=6.8, gol=10, rig_calciati=0, qi=20).valoreBase
    con = valuta_giocatore("A", presenze=34, fm=6.8, gol=10, rig_calciati=6, qi=20).valoreBase
    assert con > senza


def test_shrinkage_regredisce_verso_il_prior():
    # con pochissime presenze la fm proiettata resta vicina al prior, non alla fm grezza
    fmp = fantamedia_proiettata(fm=9.0, presenze=2, ruolo="A")
    assert fmp < 7.5  # non si fida di 2 partite fortunate
    # con tante presenze la proiezione si avvicina alla fm reale
    fmp2 = fantamedia_proiettata(fm=9.0, presenze=36, ruolo="A")
    assert fmp2 > 8.5


def test_nuovo_senza_storico_usa_la_quotazione():
    v = valuta_giocatore("A", presenze=0, fm=0, qi=25, is_nuovo=True)
    assert v.fonte == "qi"
    assert v.valoreBase > 0  # un Qi alto dà comunque valore
    # a parità di ruolo, Qi più alto → valore più alto
    v2 = valuta_giocatore("A", presenze=0, fm=0, qi=10, is_nuovo=True)
    assert v.valoreBase > v2.valoreBase


def test_replacement_ha_valore_circa_zero():
    # un titolare esattamente sulla soglia di ruolo non crea valore
    v = valuta_giocatore("D", presenze=30, fm=SOGLIA_RUOLO["D"], qi=8)
    assert abs(v.valoreBase) < 5


def test_stima_titolarita_range():
    assert 0 < stima_titolarita(0) < 0.2
    assert stima_titolarita(38) > 0.9


def test_valuta_lista_aggiunge_campi():
    players = [
        {"id": "a1", "ruolo": "A", "qi": 30, "stats2526": {"presenze": 34, "fm": 7.9, "gol": 18, "rigCalciati": 5}},
        {"id": "n1", "ruolo": "C", "qi": 12, "isNuovo": True, "stats2526": {}},
    ]
    valuta_lista(players)
    assert players[0]["valoreBase"] > players[1]["valoreBase"]
    assert all("valoreBase" in p and "fonteValore" in p for p in players)


if __name__ == "__main__":
    # esecuzione senza pytest
    import traceback

    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    ok = 0
    for fn in fns:
        try:
            fn()
            ok += 1
            print(f"  ok  {fn.__name__}")
        except AssertionError:
            print(f"  FAIL {fn.__name__}")
            traceback.print_exc()
    print(f"\n{ok}/{len(fns)} test passati")
    sys.exit(0 if ok == len(fns) else 1)
