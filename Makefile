.PHONY: up ingest malhas focos transform pipeline down

up:
	docker compose up -d --wait

malhas:
	uv run python ingest/ingest_malhas.py

focos:
	uv run python ingest/ingest_focos.py

ingest: malhas focos

transform:
	cd dbt_queimadas && uv run dbt deps --profiles-dir . && uv run dbt build --profiles-dir .

pipeline: up ingest transform

down:
	docker compose down
