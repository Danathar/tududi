---
name: add-migration
description: Create a Sequelize migration that runs on both SQLite and PostgreSQL, update the model, and run the schema-parity checks.
---

# Add a dialect-safe migration

Fork rule: PRs and issues go to this fork. Pass `--repo Danathar/tududi` to
every `gh` command and never target `chrisvel/tududi`. See
[AGENTS.md](../../../AGENTS.md), section "This repository is a fork. All work
happens here."

Fresh PostgreSQL databases skip migration history and only run migrations added
after the baseline, so every new migration runs on both engines.

1. `npm run migration:create <kebab-case-name>` (writes a template into
   `backend/migrations/`).
2. Implement `up` and a reversing `down` with the `safe*` helpers from
   `backend/utils/migration-utils.js`. Do not use `PRAGMA`, `sqlite_master`,
   `AUTOINCREMENT`, backtick identifiers or `0`/`1` booleans. Branch on
   `queryInterface.sequelize.getDialect()` only when unavoidable.
3. Update the model in `backend/models/` so a fresh install matches.
4. `npm run db:migrate` and `npm run migration:status`.
5. `npm run backend:test:upgrade` (compares migrated legacy databases with the
   models; accepted differences are in
   `backend/tests/upgrade/known-schema-drift.json`), then `npm test`. With
   `DATABASE_URL` set to PostgreSQL, also `npm run backend:test:pg`.
6. Never edit a merged migration. Details: `docs/database.md`, "Writing
   dialect-safe migrations".
