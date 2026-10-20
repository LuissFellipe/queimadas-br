import os
import time

import psycopg


def conectar(tentativas=10):
    # A imagem do PostGIS sobe um servidor temporário para criar as extensões
    # e só depois o definitivo. Nesse intervalo o pg_isready do health check já
    # responde pelo socket interno, e o proxy do Docker aceita a conexão TCP e a
    # derruba. Então "pronto" só vale quando uma conexão de verdade funciona.
    for tentativa in range(1, tentativas + 1):
        try:
            conn = psycopg.connect(
                host=os.getenv("PGHOST", "localhost"),
                port=os.getenv("PGPORT", "5434"),
                user=os.getenv("PGUSER", "queimadas"),
                password=os.getenv("PGPASSWORD", "queimadas"),
                dbname=os.getenv("PGDATABASE", "queimadas"),
            )
            conn.execute("select 1")
            conn.rollback()
            return conn
        except psycopg.OperationalError as erro:
            if tentativa == tentativas:
                raise
            print(f"banco ainda não aceita conexão ({str(erro).strip().splitlines()[0]}), nova tentativa em 3s")
            time.sleep(3)
