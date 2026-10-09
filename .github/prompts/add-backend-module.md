# Add a backend module

Fork rule: this is `Danathar/tududi`. Open the PR with
`gh pr create --repo Danathar/tududi --base main --head <branch>` and never
target `chrisvel/tududi`. See [AGENTS.md](../../AGENTS.md), section "This
repository is a fork. All work happens here."

Task: add a `<feature>` backend module.

1. Read `docs/backend-patterns.md` ("How to Add a New Module") and one existing
   small module, `backend/modules/areas/`.
2. Create `backend/modules/<feature>/` with `routes.js` (thin Express router),
   `repository.js` (all Sequelize access), `service.js`/`validation.js` as
   needed, and `index.js` exporting `routes`. Routes must not use models
   directly. Use `hasAccess` from `backend/middleware/authorize.js` for
   protected resources.
3. If a table is needed, add `backend/models/<model>.js` and a migration (use
   `.github/prompts/add-migration.md`).
4. Register the module in `backend/app.js`, the same way `areasModule` is
   required and mounted.
5. Add tests in `backend/tests/unit/` and `backend/tests/integration/`.
6. Run `npm run lint`, `npm test`, and, when a migration was added,
   `npm run backend:test:upgrade`.
7. Commit with a Conventional Commit message (no `git commit -s`), push to
   `origin`, and open the PR with the `gh` command above. Check the printed URL
   starts with `https://github.com/Danathar/tududi/`.
