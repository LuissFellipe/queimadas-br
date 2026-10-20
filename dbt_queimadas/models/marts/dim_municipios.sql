select
    municipio_id,
    nome,
    uf_sigla,
    uf_nome,
    regiao,
    round(area_km2::numeric, 1) as area_km2,
    st_y(st_pointonsurface(geom)) as lat,
    st_x(st_pointonsurface(geom)) as lon
from {{ ref('stg_ibge__municipios') }}
