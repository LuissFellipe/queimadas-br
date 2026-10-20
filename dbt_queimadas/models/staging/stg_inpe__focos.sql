select
    foco_id,
    data_hora_gmt,
    (data_hora_gmt at time zone 'UTC' at time zone 'America/Sao_Paulo')::date as data,
    lat,
    lon,
    st_setsrid(st_point(lon, lat), 4674) as geom,
    satelite,
    municipio_id_inpe,
    nullif(bioma, '') as bioma_inpe,
    frp,
    -- O INPE usa valores negativos como "sem dado" no risco e na chuva.
    case when risco_fogo between 0 and 1 then risco_fogo end as risco_fogo,
    case when dias_sem_chuva >= 0 then dias_sem_chuva::int end as dias_sem_chuva,
    case when precipitacao >= 0 then precipitacao end as precipitacao
from {{ source('raw', 'focos') }}
