# Change risk tiers

How to classify a change to this fork, and what each tier requires before it
merges. Reviewers and agents use it. [Agent boundaries](agent-boundaries.md)
maps the tiers to what an agent may change without the owner.

The tier is set by **what the change can break**, not by diff size. A one-line
change to a Sequelize migration is Tier 1. A 300-line docs change is Tier 4.

This file is the source. [`risk-config.json`](../risk-config.json) restates the
table below as data, and `node scripts/check-policies.mjs` fails when the two
disagree. To change a tier, edit both in the same pull request.

## Tier table

Tier 1 is the most dangerous. `**` matches any depth, `*` matches within one
directory level.

| Tier | Name | Covers | Required commands | Review |
| ---- | ---- | ------ | ----------------- | ------ |
| 1 | critical | `backend/migrations/**`, `backend/models/**`, `backend/middleware/**`, `backend/services/backupService.js`, `Dockerfile`, `scripts/docker-entrypoint.sh`, `.github/workflows/**`, `.github/CODEOWNERS`, `policies/**`, `risk-config.json`, `LICENSE*`, `package.json`, `package-lock.json`, `AGENTS.md` | `npm run lint`, `npm run backend:test`, `npm run backend:test:pg`, `npm run backend:test:upgrade` | `owner` |
| 2 | high | `backend/modules/auth/**`, `backend/modules/oidc/**`, `backend/modules/oauth/**`, `backend/modules/backup/**`, `backend/modules/telegram/**`, `backend/modules/mcp/**`, `backend/modules/ai-assistant/**`, `backend/config/**`, `backend/services/permissionsService.js`, `backend/services/sessionService.js`, `docker-compose.yml`, `docker-compose.dev.yml` | `npm run lint`, `npm run backend:test` | `owner` |
| 3 | medium | `backend/modules/**`, `backend/services/**`, `backend/utils/**`, `backend/tests/**`, `frontend/**`, `e2e/**`, `CLAUDE.md` | `npm run lint`, `npm run backend:test`, `npm run frontend:test` | `ci` |
| 4 | low | `docs/**`, `public/locales/**`, `*.md`, `.editorconfig` | none | `ci` |

Review values: `owner` means the repository owner (Danathar) reads the diff and
merges it, and a green CI run alone is not enough. `ci` means the required CI
checks (`test-sqlite` and `test-postgres` in `.github/workflows/ci.yml`) must
pass, and an agent may open and, under the Hive merge strategy, queue the pull
request.

## How to apply it

1. List every path the change touches.
2. Take the **highest-risk** (lowest-numbered) tier any path matches. A path
   that matches several rows, such as `AGENTS.md` (Tier 1) and `*.md` (Tier 4),
   takes the lowest number.
3. A path no row lists is Tier 3.
4. Raise the tier, never lower it, when the change is riskier than its path
   says. Examples: a "docs" change that edits an SQL snippet users copy into a
   production database, or a frontend change that builds a request URL from
   user input.
5. Run every command in the tier's Required column. A pull request that spans
   tiers meets the requirements of its highest tier.

`node scripts/check-policies.mjs --classify <path> ...` prints the tier the
path table assigns to each path.

## Why these paths

- **`backend/migrations/**` and `backend/models/**`.** Migrations rewrite users'
  data in place and run when the container starts (`backend/cmd/start.sh`). Models define the schema the
  migrations must reproduce. `npm run backend:test:upgrade` runs the real migrations
  against legacy SQLite databases and checks schema parity, and `backend:test:pg`
  repeats the suite on PostgreSQL, because SQLite accepts SQL that PostgreSQL
  rejects.
- **`backend/middleware/**`.** Authentication, authorization, CSRF, rate
  limiting and upload access control. A mistake here exposes other users' data
  and no test needs to fail for it to happen.
- **`backend/services/backupService.js`.** Backup and restore. It refuses to
  restore a backup that claims a newer app version than the running one, which
  is why `package.json` keeps upstream's version (see
  [AGENTS.md](../AGENTS.md)).
- **`Dockerfile`, `scripts/docker-entrypoint.sh`, `.github/workflows/**`.** What
  ships to `ghcr.io/danathar/tududi` and what runs with repository tokens. See
  [AI security policy](security/SECURITY-AI.md).
- **`LICENSE*`, `package.json`, `package-lock.json`.** Licence
  text and identifiers are fixed by [AGENTS.md](../AGENTS.md), and the version
  must not be bumped. Dependency changes alter what runs in the image.
- **`AGENTS.md`, `policies/**`, `risk-config.json`, `.github/CODEOWNERS`.** The
  rules that bound agents. They are changed by the owner, never by the agent
  they constrain.
- **Tier 2 modules.** Features that handle credentials or call out to other
  systems: sign-in (`auth`, `oidc`, `oauth`), backups, the Telegram bot, MCP,
  and the AI assistant. A bug is contained to that feature but can leak a
  secret or a user's data.

## Pull request notes by tier

- Tier 1 and Tier 2: state in the PR body which of the required commands ran
  and what they printed, and what could not be run (for example the PostgreSQL
  suite without a local server).
- Tier 1 changes to a workflow: say what was verified and what could not be
  (a cron schedule cannot be proven before it fires).
- Tier 1 changes to `backend/migrations/**`: run `npm run backend:test:upgrade`
  and read [docs/testing.md](testing.md) and [docs/database.md](database.md)
  first.

See also [`.github/CODEOWNERS`](../.github/CODEOWNERS) and the
[review rubric](review-rubric.md).
