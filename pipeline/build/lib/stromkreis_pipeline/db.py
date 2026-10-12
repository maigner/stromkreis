"""DB-Verbindung der Pipeline.

Bevorzugt DATABASE_URL (wie im Compose-Stack), sonst der pg_service-Eintrag
"stromkreis" (lokale Entwicklung, .pg_service.conf ist gitignored).
"""

import os

import psycopg


def connect():
    url = os.environ.get("DATABASE_URL")
    if url:
        return psycopg.connect(url)
    return psycopg.connect("service=stromkreis")
