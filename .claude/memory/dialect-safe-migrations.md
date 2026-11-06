# Migrations must run on an existing PostgreSQL database

**Date:** 2026-10-09, rewritten when v2.0.0 dropped SQLite
**Wrong:** trusting CI to exercise a new migration, or writing one that only
works on an empty schema.
**Right:** use the `safe*` helpers in `backend/utils/migration-utils.js` and
follow "Writing migrations" in [docs/database.md](../../docs/database.md). Run
the migration yourself against an existing PostgreSQL database that was created
before it. Use a disposable database only: start a throwaway container
(`postgres:16-alpine`),
`export DATABASE_URL=postgres://tududi:tududi@localhost:5432/tududi_scratch`,
and confirm it names the scratch database before running anything
(`db:prepare` and `migration:run` write to whatever it names). Check only the
host and database name (`echo "${DATABASE_URL##*@}"`); never print the whole
URL, which contains the password. Bootstrap with the base commit
(`npm run db:prepare`), switch to your branch, run `npm run migration:run` with
the same `DATABASE_URL`, then delete the container. Never point `DATABASE_URL`
at a database holding real data. Never edit a migration that has shipped; add a
new one (docs/database.md, "Never Modify Released Migrations").
**Why it matters:** CI cannot catch this. `backend/scripts/db-prepare.js` builds
an empty database from the models and records every migration file in the tree
as already applied, including the one your PR adds, so `test-postgres` never
executes it. Only migrations added after that baseline run, on existing
databases.
**Evidence:** [docs/database.md](../../docs/database.md) ("How the schema is
created"); `.github/workflows/ci.yml` job `test-postgres`.
