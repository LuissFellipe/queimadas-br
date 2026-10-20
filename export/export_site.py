"""Gera os arquivos estáticos que o mapa consome, em site/data/.

Só sai agregação: o navegador nunca recebe o foco bruto. Os hexágonos H3 são
calculados aqui porque a imagem do PostGIS não traz a extensão h3.
"""

import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import h3

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ingest"))
from db import conectar  # noqa: E402

RESOLUCAO_H3 = 5
SAIDA = Path(__file__).resolve().parents[1] / "site" / "data"
BIOMAS = ["Amazônia", "Cerrado", "Caatinga", "Mata Atlântica", "Pantanal", "Pampa"]


def gravar(caminho, dados):
    caminho.parent.mkdir(parents=True, exist_ok=True)
    caminho.write_text(json.dumps(dados, ensure_ascii=False, separators=(",", ":")))
    return caminho.stat().st_size


def indice_bioma(bioma):
    return BIOMAS.index(bioma) if bioma in BIOMAS else len(BIOMAS)


def exportar_hexagonos(conn):
    # chave (ano) -> Counter[(célula, mês, bioma)]
    por_ano = defaultdict(Counter)
    cursor = conn.cursor(name="focos")
    cursor.itersize = 50_000
    cursor.execute(
        """select extract(year from data)::int, extract(month from data)::int, bioma, lat, lon
           from intermediate.int_focos__geolocalizados"""
    )
    for ano, mes, bioma, lat, lon in cursor:
        celula = h3.latlng_to_cell(lat, lon, RESOLUCAO_H3)
        por_ano[ano][(celula, mes, indice_bioma(bioma))] += 1

    tamanhos = {}
    for ano, contagem in sorted(por_ano.items()):
        celulas = sorted({c for c, _, _ in contagem})
        posicao = {c: i for i, c in enumerate(celulas)}
        linhas = []
        for (celula, mes, bioma), focos in sorted(contagem.items()):
            linhas += [posicao[celula], mes, bioma, focos]
        tamanhos[ano] = gravar(SAIDA / "h3" / f"{ano}.json", {"celulas": celulas, "linhas": linhas})
    return tamanhos


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
        "resolucao_h3": RESOLUCAO_H3,
        "meses": sorted(mensal),
        "mensal_por_bioma": [mensal[m] for m in sorted(mensal)],
        "ultimo_foco_gmt": ultimo_foco.isoformat(),
        "gerado_em": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    })


def main():
    with conectar() as conn:
        hex_tam = exportar_hexagonos(conn)
        geo_tam, series_tam = exportar_municipios(conn)
        meta_tam = exportar_meta(conn)
    kb = lambda b: f"{b / 1024:.0f} KB"
    for ano, tam in hex_tam.items():
        print(f"h3/{ano}.json: {kb(tam)}")
    print(f"municipios.geojson: {kb(geo_tam)}")
    print(f"municipios_series.json: {kb(series_tam)}")
    print(f"meta.json: {kb(meta_tam)}")


if __name__ == "__main__":
    main()
