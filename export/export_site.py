"""Gera os arquivos estáticos que o mapa consome, em site/data/.

Os focos saem com o mínimo para o mapa (coordenada, dia e bioma), um arquivo
por ano. O navegador agrupa em hexágonos H3 na resolução do zoom: com uma
resolução fixa, o hexágono que faz sentido no país cobre vários municípios
quando se aproxima de uma cidade.
"""

import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ingest"))
from db import conectar  # noqa: E402

SAIDA = Path(__file__).resolve().parents[1] / "site" / "data"
BIOMAS = ["Amazônia", "Cerrado", "Caatinga", "Mata Atlântica", "Pantanal", "Pampa"]


def gravar(caminho, dados):
    caminho.parent.mkdir(parents=True, exist_ok=True)
    caminho.write_text(json.dumps(dados, ensure_ascii=False, separators=(",", ":")))
    return caminho.stat().st_size


def indice_bioma(bioma):
    return BIOMAS.index(bioma) if bioma in BIOMAS else len(BIOMAS)


def exportar_focos(conn):
    # Por ano, em sequência: lat e lon em milésimos de grau (~110 m, abaixo do
    # pixel de 1 km do sensor), dia do ano e índice do bioma.
    por_ano = defaultdict(list)
    cursor = conn.cursor(name="focos")
    cursor.itersize = 50_000
    cursor.execute(
        """select extract(year from data)::int, extract(doy from data)::int, bioma, lat, lon
           from intermediate.int_focos__geolocalizados
           order by data"""
    )
    for ano, dia, bioma, lat, lon in cursor:
        por_ano[ano] += [round(lat * 1000), round(lon * 1000), dia, indice_bioma(bioma)]
    return {ano: gravar(SAIDA / "focos" / f"{ano}.json", linhas) for ano, linhas in sorted(por_ano.items())}


def exportar_municipios(conn):
    # Simplificação só para desenhar: ~1 km de tolerância e 3 casas decimais.
    linhas = conn.execute(
        """select m.municipio_id, m.nome, m.uf_sigla,
                  st_asgeojson(st_simplifypreservetopology(s.geom, 0.01), 3)
           from marts.dim_municipios m
           join staging.stg_ibge__municipios s using (municipio_id)"""
    ).fetchall()
    geojson = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "id": mid,
             "properties": {"id": mid, "nome": nome, "uf": uf},
             "geometry": json.loads(geom)}
            for mid, nome, uf, geom in linhas
        ],
    }
    tamanho_geo = gravar(SAIDA / "municipios.geojson", geojson)

    series = defaultdict(list)
    for mid, ano, mes, bioma, focos in conn.execute(
        """select municipio_id, extract(year from data)::int, extract(month from data)::int,
                  bioma, sum(focos)
           from marts.fct_focos_diarios_municipio
           group by 1, 2, 3, 4 order by 1, 2, 3, 4"""
    ):
        series[mid] += [ano * 100 + mes, indice_bioma(bioma), int(focos)]
    tamanho_series = gravar(SAIDA / "municipios_series.json", series)
    return tamanho_geo, tamanho_series


def exportar_meta(conn):
    mensal = defaultdict(lambda: [0] * (len(BIOMAS) + 1))
    for mes, bioma, focos in conn.execute(
        "select to_char(mes, 'YYYY-MM'), bioma, focos from marts.fct_focos_bioma_mensal"
    ):
        mensal[mes][indice_bioma(bioma)] += focos
    ultimo_foco = conn.execute(
        "select max(data_hora_gmt) from intermediate.int_focos__geolocalizados"
    ).fetchone()[0]
    return gravar(SAIDA / "meta.json", {
        "biomas": BIOMAS + ["Não informado"],
        "meses": sorted(mensal),
        "mensal_por_bioma": [mensal[m] for m in sorted(mensal)],
        "ultimo_foco_gmt": ultimo_foco.isoformat(),
        "gerado_em": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    })


def main():
    with conectar() as conn:
        focos_tam = exportar_focos(conn)
        geo_tam, series_tam = exportar_municipios(conn)
        meta_tam = exportar_meta(conn)
    kb = lambda b: f"{b / 1024:.0f} KB"
    for ano, tam in focos_tam.items():
        print(f"focos/{ano}.json: {kb(tam)}")
    print(f"municipios.geojson: {kb(geo_tam)}")
    print(f"municipios_series.json: {kb(series_tam)}")
    print(f"meta.json: {kb(meta_tam)}")


if __name__ == "__main__":
    main()
