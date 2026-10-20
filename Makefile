.PHONY: up ingest malhas focos transform export docs site pipeline down

# As etapas dependem uma da outra pela ordem, não por arquivos: com make -j o
# transform rodaria antes de a ingestão terminar.
.NOTPARALLEL:

up:
	docker compose up -d --wait

malhas:
	uv run python ingest/ingest_malhas.py

focos:
	uv run python ingest/ingest_focos.py

ingest: malhas focos

transform:
	cd dbt_queimadas && uv run dbt deps --profiles-dir . && uv run dbt build --profiles-dir .

pipeline: up ingest transform export

down:
	docker compose down

export:
	uv run python export/export_site.py

# Documentação do dbt como página estática, publicada junto com o mapa em /dbt/.
docs:
	cd dbt_queimadas && uv run dbt docs generate --static --profiles-dir .
	mkdir -p site/dbt && cp dbt_queimadas/target/static_index.html site/dbt/index.html

site: export
	@echo "abra http://localhost:8000"
	uv run python -m http.server 8000 -d site
