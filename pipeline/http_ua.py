"""http_ua.py — User-Agent UNICO degli scraper verso fantacalcio.it.

Dal 12/11/2026 il sito risponde 403 alla stringa "Mozilla/5.0" secca (finto browser
incompleto), mentre accetta un client che si dichiara per quello che è. Quindi ci
identifichiamo onestamente: NON sostituire con uno User-Agent da browser.
Se il sito cambiasse ancora politica, si interviene solo qui.
"""
UA = "FantaAstaBot/1.0 (aggiornamento dati lega privata, uso personale)"
