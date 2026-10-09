# PR review rubric

How changes to this repository (`Danathar/tududi`, a fork) get reviewed.
Written for the owner, for agents reviewing, and for agents checking their own
work before opening a PR. Repository rules live in [AGENTS.md](../AGENTS.md);
commands and architecture in [CLAUDE.md](../CLAUDE.md). Where this page and
AGENTS.md disagree, AGENTS.md wins.

Review in this order. The first section that fails is the one to fix.

## Severity levels

Review findings use the four levels the Codex connector (`chatgpt-codex-connector`)
already posts on this repository's PRs as `P0`-`P3` badges, so a human, an agent
and Codex all describe a finding the same way. Codex has posted `P1` and `P2`
findings on this repository so far (for example on #5, #8, #9 and #10); `P0`
and `P3` are defined here so the scale is complete.

| level | meaning | merge? |
|---|---|---|
| P0 | Data loss or corruption, a security hole (authorization bypass, secret exposure), a broken migration on either database, or a licence violation | Never. Fix first, even if CI is green |
| P1 | Wrong behaviour users or deployments will hit: a feature that does not do what it claims, a workflow that publishes or deletes the wrong thing, a migration that fails on one dialect | Not until fixed, or the owner accepts the risk in the PR thread |
| P2 | Real but narrow: an edge case, a missing test for a risky path, a mis-scoped predicate, a retry that marks work done too early | Fix in the PR, or reply with why it does not apply and resolve the thread |
| P3 | Style, naming, small cleanup, documentation wording | Optional; do not block on it |

Codex findings are advisory. Verify each against the code before acting; reply
with the reasoning and resolve the thread either way.

## 1. Scope and rules

- [ ] **Fork rule.** The PR targets `Danathar/tududi` `main`, and any command
      or workflow it adds names `--repo Danathar/tududi`. Anything that would
      open or touch an issue or PR on `chrisvel/tududi` is P0.
      (AGENTS.md, "This repository is a fork. All work happens here.")
- [ ] **Licence rules.** `LICENSE.MIT` is untouched; the README licence
      attribution stays; licence identifiers in `package.json`,
      `package-lock.json` and `backend/config/swagger.js` stay GPL-3.0-only;
      copied-in code carries a GPL-3.0-compatible licence and its notice.
- [ ] **No version bump.** `package.json` `version` is unchanged; it only moves
      with an upstream sync.
- [ ] **No upstream plumbing.** No tag-driven release or deploy workflow, no
      scheduled upstream sync, no image references to `chrisvel/tududi` or
      Docker Hub (the image is `ghcr.io/danathar/tududi`).
- [ ] **Risk tier.** Find the tier of the paths touched in
      [risk-tiers.md](risk-tiers.md) and review at that depth: the more
      sensitive the path, the more of sections 2-5 apply and the less a green
      CI is worth by itself. Agent limits per path are in
      [agent-boundaries.md](agent-boundaries.md).
- [ ] **Size of the change fits the problem.** A bug fix does not refactor
      its neighbours.

## 2. Correctness

- [ ] Does the code do what the PR description says? Read the diff against the
      description, not just for syntax.
- [ ] Predicates and filters match the real state space (a URL, status or
      filter combination the UI can actually produce), not only the common one.
- [ ] Background jobs and retries mark work done only after it succeeded, and
      stay safe to run twice.
- [ ] Settings and environment variables the code reads are the ones the docs
      and compose files document; text that promises a behaviour (retention
      periods, defaults) renders the configured value.

## 3. Database and migrations

Every new migration runs on both SQLite and PostgreSQL. The full checklist is
[docs/database.md](database.md), "Writing dialect-safe migrations".

- [ ] Uses the `safe*` helpers from `backend/utils/migration-utils.js`; no
      `PRAGMA`, `sqlite_master`, `AUTOINCREMENT`, backtick identifiers or
      hand-rolled table rebuilds (the one documented exception is the pattern
      in `20260920000002-make-user-email-nullable.js`).
- [ ] Booleans compared and written as `true`/`false`; JSON columns guarded
      with `typeof value === 'string'`; raw-SQL aliases quoted.
- [ ] Per-engine application code goes through `backend/utils/db-dialect.js`
      only.
- [ ] The model and the migration agree. `npm run backend:test:upgrade`
      compares the schema an upgraded legacy database ends up with against the
      models; a new column needs both. CI runs it on SQLite and on PostgreSQL
      (`test-sqlite`, `test-postgres` in `.github/workflows/ci.yml`).
- [ ] Released migrations are not edited. `up` and `down` both exist.
- [ ] A migration that loses data on failure runs in a transaction, snapshots
      first where docs/backups.md says to, and is a no-op when already applied.

## 4. Authorization and data access

- [ ] Every new route that reads or writes a user's resource is guarded by
      `hasAccess(level, resourceType, getResourceUid)` from
      `backend/middleware/authorize.js`, with the right level (RO, RW, ADMIN)
      for the verb. A route that only checks "is logged in" is P0 if it
      returns another user's data.
- [ ] Tasks and Notes inherit access from their parent Project; a new
      endpoint reaching them goes through that inheritance, not around it.
- [ ] Queries are scoped to the current user or a granted permission; ids
      from the request are never trusted as ownership.
- [ ] All three auth paths (session cookie, `tt_` API token, OIDC bearer) end
      in `req.currentUser`; new code reads that, not a header.
- [ ] No secrets, tokens or personal data in logs, fixtures or docs.

## 5. Tests

- [ ] New behaviour has a test that fails without the change. Backend tests
      are Jest under `backend/tests/` (`unit/`, `integration/`, `upgrade/`);
      frontend tests under `frontend/__tests__/`; browser flows under
      `e2e/tests/` (Playwright). Layout: [testing.md](testing.md).
- [ ] Tests check behaviour and boundaries, not that a function was called.
- [ ] A fix for a bug includes the test that would have caught it.
- [ ] CI (`test-sqlite` and `test-postgres`) is green **and the branch is
      current with `main`**. A green run on a stale branch says little about
      the merge result.
- [ ] Known gap: `ci.yml` does not run `npm run frontend:test`, so frontend
      test changes are only verified if the author reports running it. Ask for
      the command and result in the PR body.

## 6. Frontend and translations

- [ ] User-visible strings use translation keys (`t('...')` from
      `react-i18next`), never literals in components.
- [ ] New keys are added to `public/locales/en/translation.json`, the source
      of truth. `frontend/i18n.ts` falls back to `en`, so a key missing from
      another locale shows English rather than breaking. Nothing in CI checks
      locale parity (at the time of writing English has far more keys than the
      other 24 locale folders), so add the key to the other locales when you
      can translate it faithfully, and never leave a half-translated or
      machine-garbled value; omitting a key is better than a wrong one.
- [ ] Placeholders (`{{name}}`) survive translation unchanged.
- [ ] `npm run lint` and `npm run format` pass; TypeScript compiles
      (`npm run build` runs `tsc --noEmit`).

## 7. Housekeeping

- [ ] Commits follow Conventional Commits; the PR title does too. No
      `Signed-off-by` trailers unless the owner asked.
- [ ] Docs changed with behaviour: the matching file under `docs/`, and
      `CLAUDE.md` or `AGENTS.md` if a rule or command changed.
- [ ] Workflows: top-level `permissions:` least-privilege, third-party actions
      pinned to a full commit SHA with a `# vX` comment, event-controlled
      strings passed through `env:` rather than interpolated into `run:`, no
      `pull_request_target`. A workflow that calls `gh` sets
      `GH_REPO: ${{ github.repository }}`.
- [ ] No generated or local files committed (build output, `.env`, database
      files, scratch under `/tmp`).

## Reviewing agent PRs (Hive and others)

- The agent's own report is a claim, not evidence. Check the commands it says
  it ran against the CI result and the diff.
- Hive PRs end with a signature line (`- hive: agent=<name>`); the author is
  `app/danathar-atomic-hive`. They get the same rubric as a human PR, and
  their outcomes are the "Hive app" row of [metrics.md](metrics.md).
- A PR that widens what an agent may do (workflows, `.claude/settings.json`,
  hooks, rulesets) is reviewed at the highest tier whatever its size.
- Do not push to a contributor's branch to fix it; comment instead.
