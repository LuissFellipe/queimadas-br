with mensal as (
    select
        date_trunc('month', data)::date as mes,
        coalesce(bioma, 'Não informado') as bioma,
        count(*) as focos
    from {{ ref('int_focos__geolocalizados') }}
    group by 1, 2
)

select
    mes,
    bioma,
    focos,
    lag(focos) over (partition by bioma, extract(month from mes) order by mes) as focos_mesmo_mes_ano_anterior
from mensal
