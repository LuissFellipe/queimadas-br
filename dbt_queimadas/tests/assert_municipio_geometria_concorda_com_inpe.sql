-- Onde o INPE informa o código IBGE (ano corrente), o município achado pela
-- geometria tem de concordar em pelo menos 98% dos focos. Abaixo disso, a
-- malha ou o spatial join quebrou.
with comparados as (
    select municipio_id = municipio_id_inpe as concorda
    from {{ ref('int_focos__geolocalizados') }}
    where municipio_id_inpe is not null
)

select count(*) filter (where concorda)::numeric / count(*) as taxa
from comparados
having count(*) filter (where concorda)::numeric / count(*) < 0.98
