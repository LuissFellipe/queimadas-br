{{ config(indexes=[{'columns': ['foco_id'], 'unique': true}, {'columns': ['data']}]) }}

-- O anual de referência não traz código IBGE, então o município sai da
-- geometria. Foco que cai fora de toda a malha (litoral, foz de rio) fica com
-- o município mais próximo, desde que a até 10 km.
with focos as (
    select * from {{ ref('stg_inpe__focos') }}
),

dentro as (
    select f.foco_id, m.municipio_id
    from focos f
    join {{ ref('int_municipios__subdivididos') }} m on st_intersects(m.geom, f.geom)
),

dentro_unico as (
    -- Ponto exatamente na divisa encosta em dois municípios: fica o de menor código.
    select distinct on (foco_id) foco_id, municipio_id
    from dentro
    order by foco_id, municipio_id
),

proximos as (
    select f.foco_id, m.municipio_id
    from focos f
    left join dentro_unico d using (foco_id)
    cross join lateral (
        select municipio_id, geom from {{ ref('int_municipios__subdivididos') }}
        order by geom <-> f.geom
        limit 1
    ) m
    where d.foco_id is null
      and st_dwithin(m.geom::geography, f.geom::geography, 10000)
)

select
    f.foco_id,
    f.data_hora_gmt,
    f.data,
    f.lat,
    f.lon,
    f.geom,
    coalesce(d.municipio_id, p.municipio_id) as municipio_id,
    case
        when d.municipio_id is not null then 'dentro'
        when p.municipio_id is not null then 'mais_proximo'
    end as metodo_municipio,
    f.municipio_id_inpe,
    f.bioma_inpe as bioma,
    f.frp,
    f.risco_fogo,
    f.dias_sem_chuva,
    f.precipitacao
from focos f
left join dentro_unico d using (foco_id)
left join proximos p using (foco_id)
