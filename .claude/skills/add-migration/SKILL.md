---
name: add-migration
description: Create a Sequelize migration that runs on an existing PostgreSQL database, update the model, and run it against a disposable database.
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
   `backend/utils/migration-utils.js`. Write booleans as `true`/`false`.
3. Update the model in `backend/models/` so a fresh install matches.
4. `npm run db:migrate` and `npm run migration:status`.
5. `npm test`. It builds its database from the models and never runs the new
   migration, so step 4 on a disposable database is the real check.
6. Never edit a merged migration. Details: `docs/database.md`, "Writing
   migrations".
