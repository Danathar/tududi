# Copilot instructions for tududi

**Fork rule (read first).** This repository is `Danathar/tududi`, a fork of
`chrisvel/tududi`. Open every pull request and issue here: pass
`--repo Danathar/tududi` to every `gh pr`, `gh issue`, `gh release` and
`gh workflow` command, and never target `chrisvel/tududi`. Push only to
`origin`. The full rules are in [AGENTS.md](../AGENTS.md), section "This
repository is a fork. All work happens here."; `AGENTS.md` wins over this file.
The codebase guide is [CLAUDE.md](../CLAUDE.md).

## Stack

Tududi is a self-hosted task manager. Frontend: React 18 + TypeScript, Webpack,
Tailwind, Zustand + SWR, i18next. Backend: Express + Sequelize on SQLite
(default) or PostgreSQL (`DATABASE_URL`). Tests: Jest, Supertest, Playwright.
Node 22.

## Commands (all from the repository root; names are in `package.json`)

- `npm install`, then `npm run db:init`, then `npm start` (frontend :8080,
  backend :3002).
- `npm run lint` (frontend + backend ESLint), `npm run lint:fix`,
  `npm run format` / `npm run format:fix` (Prettier).
- `npm test` (backend Jest), `npm run backend:test:unit`,
  `npm run backend:test:integration`, `npm run backend:test:pg` (with
  `DATABASE_URL` set), `npm run backend:test:upgrade`.
- `npm run frontend:test`, `npm run test:ui` (Playwright), `npm run build`
  (`tsc --noEmit` + Webpack).
- `npm run migration:create <name>`, `npm run db:migrate`,
  `npm run migration:status`.

CI (`.github/workflows/ci.yml`) runs `test-sqlite` (lint, backend tests,
upgrade tests, build) and `test-postgres` (migrations and backend tests on
PostgreSQL 16). Both must pass.

## Backend pattern

Features live in `backend/modules/<feature>/`: `routes.js` (thin Express
router) calls `repository.js` (Sequelize access), with optional `operations/`
and `core/`. Routes never touch models directly. Register a new module in
`backend/app.js` (see how `areasModule` is required and mounted). Details:
[docs/backend-patterns.md](../docs/backend-patterns.md).

Frontend API calls go through `frontend/utils/<resource>Service.ts`, not ad-hoc
`fetch`.

## Tests

Backend tests are in `backend/tests/unit` and `backend/tests/integration`;
frontend tests sit beside the components. Add or update a test with every
behaviour change. Run one backend file with
`cd backend && npx jest tests/unit/models/task.test.js`. PR #9
reported three frontend suites failing on a clean `main` (`MermaidDiagram`,
`MarkdownRenderer.publicLinks`, `roleLabels`); that is historical. Rerun a
failing suite on current `main` before calling it pre-existing.

## Migrations must run on both databases

Fresh PostgreSQL databases skip history and run only newer migrations, so every
new migration runs on SQLite and PostgreSQL. Use the `safe*` helpers in
`backend/utils/migration-utils.js`; no `PRAGMA`, `sqlite_master`,
`AUTOINCREMENT` or backtick identifiers; booleans as `true`/`false`. Run
`npm run backend:test:upgrade` after adding one. Checklist:
[docs/database.md](../docs/database.md), "Writing dialect-safe migrations".

## Translations

English is the source: `public/locales/en/translation.json`. Add every new key
to all 25 locale folders under `public/locales/`. There is no sync script
(`.github/CONTRIBUTING.md` mentions `npm run translations:sync`, which does not
exist in `package.json`).

## Licence and versions

The fork is GPL-3.0-only. Never edit or delete `LICENSE.MIT`, and do not change
licence identifiers back to MIT or ISC. Do not bump the version in
`package.json`. Do not add a scheduled upstream sync or point images at Docker
Hub; the image is `ghcr.io/danathar/tududi`.

## Style

Prettier: 4 spaces, single quotes, semicolons, ES5 trailing commas
(`.prettierrc.json`). Conventional Commit messages. Never use `git commit -s`.

## Other agent files

See the "Agent tooling" section of [AGENTS.md](../AGENTS.md); task prompts are
in [.github/prompts/](prompts/README.md).
