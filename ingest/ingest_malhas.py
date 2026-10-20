import json

import requests

from db import conectar

URL_MALHA = "https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR"
URL_NOMES = "https://servicodados.ibge.gov.br/api/v1/localidades/municipios"

DDL = """
create extension if not exists postgis;
create schema if not exists raw;
create table if not exists raw.municipios (
    municipio_id int primary key,
    nome text,
    uf_sigla text,
    uf_nome text,
    regiao text,
    geom geometry(MultiPolygon, 4674) not null,
    carregado_em timestamptz not null default now()
);
create index if not exists municipios_geom_idx on raw.municipios using gist (geom);
"""


def main():
    malha = requests.get(
        URL_MALHA,
        params={
            "formato": "application/vnd.geo+json",
            "qualidade": "intermediaria",
            "intrarregiao": "municipio",
        },
        timeout=300,
    )
    malha.raise_for_status()
    nomes = requests.get(URL_NOMES, params={"view": "nivelado"}, timeout=120)
    nomes.raise_for_status()
    por_id = {m["municipio-id"]: m for m in nomes.json()}

    linhas = []
    for feature in malha.json()["features"]:
        codigo = int(feature["properties"]["codarea"])
        m = por_id.get(codigo, {})
        linhas.append((
            codigo,
            m.get("municipio-nome"),
            m.get("UF-sigla"),
            m.get("UF-nome"),
            m.get("regiao-nome"),
            json.dumps(feature["geometry"]),
        ))

    with conectar() as conn:
        conn.execute(DDL)
        with conn.cursor() as cur:
            cur.executemany(
                """insert into raw.municipios (municipio_id, nome, uf_sigla, uf_nome, regiao, geom)
                   values (%s, %s, %s, %s, %s,
                           st_multi(st_collectionextract(
                               st_makevalid(st_setsrid(st_geomfromgeojson(%s), 4674)), 3)))
                   on conflict (municipio_id) do update set
                       nome = excluded.nome, uf_sigla = excluded.uf_sigla,
                       uf_nome = excluded.uf_nome, regiao = excluded.regiao,
                       geom = excluded.geom, carregado_em = now()""",
                linhas,
            )
    sem_nome = sum(1 for l in linhas if l[1] is None)
    print(f"municípios: {len(linhas)} polígonos ({sem_nome} sem nome no cadastro)")


if __name__ == "__main__":
    main()
