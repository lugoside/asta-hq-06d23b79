#!/usr/bin/env python3
"""
Convertitore rose FantaAsta -> CSV importabile su leghe.fantacalcio.it
(Gestione rose -> Importa).

Input:
  1) backup FULL  : fantaasta-backup.json  = { config, purchases, favorites }
     purchases[i]  = { playerId, team, price, nome, ruolo, squadra }
                     team == "__ME__" per la squadra dell'utente.
  2) players.json : docs/data/players.json  — ogni record porta `fantaId`
                     (= id nativo di fantacalcio.it), scritto da build_listone_fanta.py.
                     Il mapping id-nostro -> fantaId e' quindi gia' NEI DATI:
                     nessun crosswalk esterno da mantenere.
  3) team-map     : (opzionale) team_map.json = { "NomeAppSquadra": "NomeSitoFanta" }
                     per allineare i nomi squadra dell'app a quelli registrati sul sito.

Output:
  fanta_import.csv   (formato atteso dal sito):
     riga 1  : $,$,$
     righe   : <NomeFantaSquadra>,<id_fantacalcio>,<costo>

Uso:
  python make_fanta_import.py [backup.json] [players.json] [team_map.json] [-o out.csv]

I giocatori acquistati ma privi di `fantaId` (non nel listone fanta.it) vengono
ESCLUSI dal CSV (cosi' l'import non fallisce) e stampati come "DA INSERIRE A MANO".
"""
import json, sys, os, argparse

MY_TEAM_SENTINEL = "__ME__"
HEADER = "$,$,$"

def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("backup", nargs="?", default="fantaasta-backup.json")
    ap.add_argument("players", nargs="?",
                    default=os.path.join(os.path.dirname(__file__), "..", "docs", "data", "players.json"))
    ap.add_argument("team_map", nargs="?", default=None)
    ap.add_argument("-o", "--out", default="fanta_import.csv")
    args = ap.parse_args()

    backup = load_json(args.backup)
    players = load_json(args.players)
    fanta_by_id = {p["id"]: p.get("fantaId") for p in players}
    tmap   = load_json(args.team_map) if args.team_map and os.path.exists(args.team_map) else {}

    config    = backup.get("config", {}) or {}
    purchases = backup.get("purchases", []) or []
    my_name   = config.get("myTeam") or "La mia squadra"

    def resolve_team(name):
        if name == MY_TEAM_SENTINEL or name is None:
            name = my_name
        return tmap.get(name, name)

    rows, manual = [], []
    per_team = {}  # team -> [count, spesa]
    for pu in purchases:
        pid = pu.get("playerId")
        team = resolve_team(pu.get("team"))
        price = pu.get("price")
        fid = fanta_by_id.get(pid)
        if not fid:
            manual.append((team, pu.get("nome", pid), pu.get("squadra", "?"), pu.get("ruolo", "?"), price))
            continue
        rows.append((team, fid, price))
        c = per_team.setdefault(team, [0, 0])
        c[0] += 1; c[1] += (price or 0)

    # scrivi CSV (LF, utf-8 senza BOM)
    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        f.write(HEADER + "\n")
        for team, fid, price in rows:
            f.write(f"{team},{fid},{price}\n")

    # report
    print(f"CSV scritto: {os.path.abspath(args.out)}")
    print(f"Righe importabili: {len(rows)}  |  da inserire a mano: {len(manual)}")
    print("\n== Riepilogo per squadra ==")
    for team in sorted(per_team):
        n, sp = per_team[team]
        print(f"  {team:24} {n:2} giocatori   spesa {sp}")
    if manual:
        print("\n== DA INSERIRE A MANO (non nel crosswalk) ==")
        for team, nome, sq, ru, price in manual:
            print(f"  [{team}] {nome} ({sq}, {ru}) costo {price}  -> cerca l'id sul sito")

if __name__ == "__main__":
    main()
