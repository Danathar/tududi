# Add a dialect-safe migration

Fork rule: this is `Danathar/tududi`. Open the PR with
`gh pr create --repo Danathar/tududi --base main --head <branch>` and never
target `chrisvel/tududi`. See [AGENTS.md](../../AGENTS.md), section "This
repository is a fork. All work happens here."

Task: add a migration for `<change>`.

1. Read `docs/database.md`, section "Writing migrations".
2. `npm run migration:create <kebab-case-name>` creates the file in
   `backend/migrations/`.
3. Use the `safe*` helpers from `backend/utils/migration-utils.js`. Write
   booleans as `true`/`false`. Make `down` reverse `up`.
4. Update the Sequelize model so a fresh install matches the migrated schema.
5. Verify on a disposable PostgreSQL database created before the migration:
   `npm run db:migrate`, `npm run migration:status`, `npm test`.
6. Never edit a migration that has been merged; add a new one.
7. Commit (Conventional Commits, no `git commit -s`), push to `origin`, open
   the PR with the `gh` command above, and confirm the URL starts with
   `https://github.com/Danathar/tududi/`.
