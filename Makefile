# splatworld — see CLAUDE.md "Gates". Four processes, no server-side compute.
SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

-include .env
export

# Connection used by every db target. Point it at the compose stack or a local
# cluster; nothing else in the repo hardcodes a DSN.
PGHOST ?= localhost
PGPORT ?= 5432
PGUSER ?= postgres
PGPASSWORD ?= postgres
PGDATABASE ?= splatworld
JWT_SECRET ?= dev-secret-change-me-0123456789abcdef
AUTHENTICATOR_PASSWORD ?= authenticator
GEOSERVER_DB_PASSWORD ?= geoserver
export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE JWT_SECRET AUTHENTICATOR_PASSWORD GEOSERVER_DB_PASSWORD

PSQL := psql -v ON_ERROR_STOP=1 --no-psqlrc -q -v authpw=$(AUTHENTICATOR_PASSWORD) -v geopw=$(GEOSERVER_DB_PASSWORD)
MIGRATIONS := $(sort $(wildcard db/[0-9]*.sql))
DB_TESTS := $(sort $(wildcard db/test/[0-9]*.sql))
DB_TEST_SCRIPTS := $(sort $(wildcard db/test/[0-9]*.sh))

COMPOSE := docker compose -f infra/compose.yml --env-file .env

.PHONY: help up down logs db-reset db-migrate db-test api-test client-test lint gate

help:
	@echo 'targets: up down logs db-reset db-migrate db-test api-test client-test lint gate'

up:
	$(COMPOSE) up -d
down:
	$(COMPOSE) down -v
logs:
	$(COMPOSE) logs -f

# Drops and recreates $(PGDATABASE), then applies every migration in order.
db-reset:
	@$(PSQL) -d postgres -c 'DROP DATABASE IF EXISTS "$(PGDATABASE)" WITH (FORCE)'
	@$(PSQL) -d postgres -c 'CREATE DATABASE "$(PGDATABASE)"'
	@$(PSQL) -d postgres -c "ALTER DATABASE \"$(PGDATABASE)\" SET app.jwt_secret = '$(JWT_SECRET)'"
	@$(PSQL) -c 'CREATE EXTENSION IF NOT EXISTS postgis'
	@$(PSQL) -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto'
	@$(MAKE) --no-print-directory db-migrate

db-migrate:
	@for f in $(MIGRATIONS); do echo "  apply $$f"; $(PSQL) -f "$$f"; done
	@echo "db-reset: $(words $(MIGRATIONS)) migration(s) applied to $(PGDATABASE)"

db-test: db-reset
	@$(PSQL) -c 'CREATE EXTENSION IF NOT EXISTS pgtap'
	@if [ -n '$(DB_TESTS)' ]; then pg_prove --ext .sql -v $(DB_TESTS); else echo 'db-test: no pgTAP tests yet'; fi
	@for s in $(DB_TEST_SCRIPTS); do echo "  run $$s"; bash "$$s"; done

api-test:
	@if [ -x tools/api-test.sh ]; then bash tools/api-test.sh; else echo 'api-test: not implemented yet (WP0.9)'; fi
	@if [ -x tools/files-test.sh ]; then bash tools/files-test.sh; else echo 'api-test: files-test not implemented yet (WP0.10)'; fi

client-test:
	@if compgen -G 'client/test/*.test.js' > /dev/null; then node --test client/test/*.test.js; else echo 'client-test: no tests yet (WP1)'; fi
	@if [ -f playwright.config.js ] && [ -d node_modules/@playwright ]; then npx playwright test; else echo 'client-test: playwright not installed, browser tests skipped'; fi

lint:
	@if command -v sqlfluff > /dev/null; then sqlfluff lint db tools --disable-progress-bar; else echo 'lint: sqlfluff not installed, skipped'; fi
	@if [ -d node_modules/eslint ]; then npx eslint .; else echo 'lint: eslint not installed, skipped'; fi

gate: db-test api-test client-test lint
	@echo 'gate: green'
