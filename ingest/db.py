import os

import psycopg


def conectar():
    return psycopg.connect(
        host=os.getenv("PGHOST", "localhost"),
        port=os.getenv("PGPORT", "5434"),
        user=os.getenv("PGUSER", "queimadas"),
        password=os.getenv("PGPASSWORD", "queimadas"),
        dbname=os.getenv("PGDATABASE", "queimadas"),
    )
