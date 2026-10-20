.PHONY: up ingest malhas focos transform export site pipeline down

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

site: export
	@echo "abra http://localhost:8000"
	uv run python -m http.server 8000 -d site
