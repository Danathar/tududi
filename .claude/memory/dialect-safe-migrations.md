# Migrations must run on SQLite and PostgreSQL

**Date:** 2026-10-09
**Wrong:** writing a migration (or test fixture) that works on the default
SQLite database only: `PRAGMA`, `sqlite_master`, `AUTOINCREMENT`, backtick
identifiers, `0`/`1` booleans, unquoted table aliases, hand-rolled table
rebuilds.
**Right:** use the `safe*` helpers in `backend/utils/migration-utils.js` and
follow the checklist in the "Writing dialect-safe migrations" section of
[docs/database.md](../../docs/database.md). Branch on
`queryInterface.sequelize.getDialect()` only when unavoidable;
`backend/migrations/20251228000001-update-project-state-enum.js` shows the
pattern (separate `sqlite` and `postgres` branches). After adding a migration
run `npm run backend:test:upgrade` (SQLite legacy fixtures only), and run the
migration yourself against an existing PostgreSQL database that was created
before it. Use a disposable database only: start a throwaway container (as the
`test-postgres` job in `.github/workflows/ci.yml` does, `postgres:16-alpine`),
`export DATABASE_URL=postgres://tududi:tududi@localhost:5432/tududi_scratch`,
and print it to confirm it is the scratch database before running anything
(`db:prepare` and `migration:run` write to whatever it names). Bootstrap with
the base commit (`npm run db:prepare`), switch to your branch, run
`npm run migration:run` with the same `DATABASE_URL`, then delete the container.
Never point `DATABASE_URL` at a database holding real data.
Neither CI job does this for you (see Why it matters). Never edit a migration that has shipped;
add a new one (docs/database.md, "Never Modify Released Migrations").
**Why it matters:** CI cannot catch this. `backend/scripts/db-prepare.js:58-72,102`
records every migration file in the tree as already applied on an empty
PostgreSQL database, including the one your PR adds, so `test-postgres` never
executes it; `backend/jest.upgrade.config.js` runs only SQLite fixtures. A
fresh PostgreSQL database is created from the models and
every existing migration is marked applied without being run (a baseline), so
only migrations added after the baseline execute there (on existing databases). A SQLite-only
migration passes locally and fails on PostgreSQL installs. SQLite also loses
indexes when `safeChangeColumn` rebuilds a table: see the comment at
`backend/migrations/20260922000005-widen-oidc-identities-picture.js:5-10`.
**Evidence:** [docs/database.md](../../docs/database.md) ("Empty PostgreSQL
database" baseline bullet and the dialect-safe checklist);
`.github/workflows/ci.yml` job `test-postgres` (line 41; step "Run backend
tests against PostgreSQL" runs `npm run backend:test:pg`) next to `test-sqlite`;
upstream's three sync migrations in PR #10
(`20261005000001`..`20261005000003`) all ran on a fresh SQLite database per
the PR body. Whether they also ran on PostgreSQL was not recorded there.
