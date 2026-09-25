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
export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE JWT_SECRET AUTHENTICATOR_PASSWORD

# `geopw` is the password of a role db/0008 creates and db/0066 drops; nothing
# connects as it in between, so it only has to be some string.
PSQL := psql -v ON_ERROR_STOP=1 --no-psqlrc -q -v authpw=$(AUTHENTICATOR_PASSWORD) -v geopw=dropped-in-0066
MIGRATIONS := $(sort $(wildcard db/[0-9]*.sql))
DB_TESTS := $(sort $(wildcard db/test/[0-9]*.sql))
DB_TEST_SCRIPTS := $(sort $(wildcard db/test/[0-9]*.sh))

# --project-directory keeps relative paths in compose.yml (FILES_ROOT) rooted at
# the repo, where every tool and .env.example root them too.
COMPOSE := docker compose -f infra/compose.yml --project-directory . --env-file .env

.PHONY: help up down logs db-reset db-migrate db-test api-test client-test flow-test lint gate vendor player-run

help:
	@echo 'targets: up down logs vendor db-reset db-migrate db-test api-test client-test flow-test lint gate player-run'

# Third-party code client/ loads from a CDN, copied locally so the browser tests
# can run offline. Gitignored; tools/vendor.sh holds the pinned versions.
vendor:
	@bash tools/vendor.sh

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
	@pg_prove --ext .sql -v $(DB_TESTS)
	@for s in $(DB_TEST_SCRIPTS); do echo "  run $$s"; bash "$$s"; done

api-test:
	@bash tools/api-test.sh
	@bash tools/files-test.sh
	@bash tools/ops-test.sh
	@python3 -m unittest discover -q -s server -p 'test_*.py'

# FND.2: the flow editor's own two specs, by name — the copied modules' suite
# (which round-trips every file in client/flow/samples/) and the validation
# against a real process server, which needs ELX_URL and says so when it is not
# set. `client-test` runs the whole browser suite, these included; this target
# is for running only them.
flow-test:
	@if [ -d node_modules/@playwright ]; then \
		npx playwright test client/test/e2e/flow-modules.spec.js \
			client/test/e2e/flow-validate.spec.js; \
	else echo 'flow-test: playwright not installed, skipped'; fi

client-test:
	@node --test client/test/*.test.js
	@if $(PSQL) -c 'SELECT 1' > /dev/null 2>&1; then bash tools/test-tiles.sh; else echo 'client-test: no database, test tiles skipped'; fi
	@if [ -f playwright.config.js ] && [ -d node_modules/@playwright ]; then npx playwright test; else echo 'client-test: playwright not installed, browser tests skipped'; fi

# PLAYER-RUN.md: the stories of docs/SPEC.md §3, done by a script that behaves
# like a player, from an empty database, in one run. This is the gate the
# operator waits for; db-test, api-test and client-test stay underneath it.
player-run:
	@npx playwright test --config client/test/run/playwright.config.js $(RUN_ARGS)

lint:
	@if command -v sqlfluff > /dev/null; then sqlfluff lint db --disable-progress-bar; else echo 'lint: sqlfluff not installed, skipped'; fi
	@if [ -d node_modules/eslint ]; then npx eslint .; else echo 'lint: eslint not installed, skipped'; fi

gate: db-test api-test client-test lint
	@echo 'gate: green'
