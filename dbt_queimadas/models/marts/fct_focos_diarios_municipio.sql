select
    data,
    municipio_id,
    bioma,
    count(*) as focos,
    round(avg(frp), 1) as frp_medio,
    round(avg(risco_fogo), 2) as risco_fogo_medio
from {{ ref('int_focos__geolocalizados') }}
where municipio_id is not null
group by data, municipio_id, bioma
