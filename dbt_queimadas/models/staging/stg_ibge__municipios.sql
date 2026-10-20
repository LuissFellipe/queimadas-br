select
    municipio_id,
    nome,
    uf_sigla,
    uf_nome,
    regiao,
    geom,
    st_area(geom::geography) / 1e6 as area_km2
from {{ source('raw', 'municipios') }}
