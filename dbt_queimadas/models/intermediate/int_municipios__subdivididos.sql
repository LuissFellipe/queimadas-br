{{ config(indexes=[{'columns': ['geom'], 'type': 'gist'}]) }}

-- Polígonos quebrados em pedaços de até 128 vértices. O índice espacial passa a
-- descartar quase tudo pela caixa envolvente, e o teste exato fica barato.
select municipio_id, st_subdivide(geom, 128) as geom
from {{ ref('stg_ibge__municipios') }}
