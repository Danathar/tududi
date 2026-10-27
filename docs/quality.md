# Quality dashboard

Which quality signals this fork has, where to look at each, and the last
baseline that was actually read. There is no hosted dashboard: the signals are
GitHub Actions runs, and this page is the index. Actions for this repository
are at <https://github.com/Danathar/tududi/actions>. In a clone that has the
parent as a remote, add `--repo Danathar/tududi` to every `gh` command below
or it reads `chrisvel/tududi` (see [AGENTS.md](../AGENTS.md), section "This
repository is a fork. All work happens here.").

**Last reviewed:** 2026-10-09, at `main` = `a6225863`.

## Signals

| signal | where it lives | what it tells you | blocks merge |
|---|---|---|---|
| `test-sqlite` job | [ci.yml](../.github/workflows/ci.yml) | lint (`npm run lint`), backend Jest on SQLite (`npm run backend:test`), legacy-database upgrade and schema parity (`npm run backend:test:upgrade`), frontend build with `tsc --noEmit` (`npm run build`) | planned: required check, see [branch-protection.md](branch-protection.md) |
| `test-postgres` job | [ci.yml](../.github/workflows/ci.yml) | bootstraps an empty PostgreSQL database, runs pending migrations, backend Jest on PostgreSQL (`npm run backend:test:pg`), upgrade suite again | planned: required check |
| mutation check (`mutation` job) | [ci.yml](../.github/workflows/ci.yml), `scripts/mutation-check.mjs`, [stryker.config.mjs](../stryker.config.mjs), ledger [.mutation-survivors.json](../.mutation-survivors.json) | StrykerJS breaks the backend, frontend, `scripts/` and guard-hook source lines a pull request adds or changes, one small breakage at a time, and lists each one the tests still pass (`Survived`) or never run (`NoCoverage`), minus accepted survivors in the ledger. Skipped for upstream syncs (`chore: sync upstream`); see [Mutation check](#mutation-check) | no, advisory (`continue-on-error`) |
| coverage gate | [coverage-gate.yml](../.github/workflows/coverage-gate.yml), thresholds in [.coverage-thresholds.json](../.coverage-thresholds.json) | coverage has not dropped below the recorded floor | per that workflow |
| nightly compliance | [nightly-compliance.yml](../.github/workflows/nightly-compliance.yml) | scheduled re-check of the repository against its own rules | no, notification |
| policy check | [policy-check.yml](../.github/workflows/policy-check.yml), `scripts/check-policies.mjs`, [policies/](../policies/README.md) | agent-facing policy files are well formed and consistent | per that workflow |
| agent tooling tests | [agent-tooling.yml](../.github/workflows/agent-tooling.yml) | `node --test` over `scripts/tests/` and `.claude/hooks/tests/` (this includes the PR-metrics tests) | per that workflow |
| PR metrics | [pr-metrics.yml](../.github/workflows/pr-metrics.yml), definitions in [metrics.md](metrics.md), readings in [metrics/](metrics/README.md) | acceptance rate and time to merge, by author class | no, report only |
| Codex review | `chatgpt-codex-connector` comments on each PR | automated findings, `P0`-`P3` ([review-rubric.md](review-rubric.md)) | no, advisory |
| e2e tests | `e2e/tests/` (Playwright), `npm run test:ui` | browser flows | not run in CI; run locally |
| frontend unit tests | `frontend/__tests__/`, `npm run frontend:test` | component behaviour | not run in CI; run locally |
| image publish | [docker-publish.yml](../.github/workflows/docker-publish.yml) | `ghcr.io/danathar/tududi` builds on push to `main` | no |
| Docker upgrade test | [upgrade-docker.yml](../.github/workflows/upgrade-docker.yml) | upgrades a volume from the previous release image to a build of the checkout; on demand, on `v*` tags and weekly (Mondays), not per PR | no |

Workflows beyond `ci.yml`, `docker-publish.yml` and `upgrade-docker.yml` arrive
through their own pull requests; a link above that does not resolve yet means
that PR has not merged.

## Mutation check

Line coverage says a changed line ran in some test; it does not say anything
checked what that line did. The `mutation` job in `ci.yml` closes that gap for
the lines each pull request adds or changes:

1. `scripts/mutation-check.mjs` reads `git diff -U0 origin/main...HEAD` and
   turns the added and changed lines into StrykerJS `--mutate file:start-end`
   ranges. Only source a test suite covers is mutated:
   `backend/{modules,services,middleware,models,utils,shared}/**/*.js` for the
   backend suite, `frontend/**/*.{js,jsx,ts,tsx}` for the frontend suite, and
   the fork's own tooling (#437): `scripts/<name>.mjs` or `.js` for a
   `scripts-<name>` suite and `.claude/hooks/*.mjs` (the Bash guard and its
   shell reader) for a `hooks` suite. Tests, migrations, seeders,
   `backend/scripts/`, shell scripts, configs, `backend/models/index.js`,
   `frontend/index.tsx`, type declarations and `locales/` (including
   upstream's landing-site strings) are left out. Lines a pull request only
   deletes have nothing to mutate.
2. Stryker runs once per suite ([stryker.config.mjs](../stryker.config.mjs),
   `MUTATION_PROJECT` names the suite). The backend and frontend suites run
   only the Jest tests related to the mutated files. The tooling suites use
   Stryker's built-in `command` runner, which runs one `node --test` command
   per mutant (passed in `MUTATION_TEST_COMMAND`): a script's own
   `scripts/tests/<name>.test.mjs` and `<name>-cli.test.mjs` (every
   `scripts/tests` file when it has neither), and for the hook
   `guard-bash.test.mjs` and `gate-refusal-corpus.test.mjs`.
   `.claude/hooks/tests/shell-reader.test.mjs` is never run: it pins the
   reader's hash, so it fails for every mutant and would count each one as
   killed. Reports land in `reports/mutation/<suite>.json` (ignored by git).
3. Every `Survived` or `NoCoverage` mutant is a change to the pull request's
   lines that no test notices. The script drops those accepted in
   [.mutation-survivors.json](../.mutation-survivors.json) and lists the rest.

Exit status: `0` nothing new, `1` at least one new survivor, `2` the check
could not run (bad arguments, git or Stryker failure, malformed ledger). The
job is advisory (`continue-on-error: true`) and not a required check. Note that
`continue-on-error` does not change the check's own result: a red mutation
check still shows as failed on the pull request, and the hive's merge gate
reads a failed check as blocking. Whether to make it required is a later
decision.

**Time limits (#435).** A change to a file most of the backend loads (one that
`backend/models/user.js` imports, say) makes Stryker's first, unmutated test
run cover most of the backend integration suite, about 10 minutes on CI.

- `stryker.config.mjs` sets `dryRunTimeoutMinutes: 55` for that first run;
  Stryker's default of 5 minutes stopped it before any mutant ran.
- The job passes `--budget-minutes 50`, a wall-clock limit for the Stryker runs
  together, inside a 60 minute job timeout that is left as a backstop (a job
  cut off by its timeout fails the check). At the budget the Stryker run in
  progress is stopped with its whole process group (SIGTERM, then SIGKILL
  after 5 seconds), the suites after it are not started (each suite gets only
  what is left of the budget), and the log, a
  `::warning::` annotation and the step summary say the result is incomplete.
  The check then exits `0`, unless a suite that finished before the budget
  found a new survivor (`1`, as usual). A green check with that warning means
  "no result", not "no survivors".
- Without `--budget-minutes` there is no limit, which is how a local run works
  unless you pass it.

For each new survivor, add a test that fails on it. Only when the mutant is
equivalent (the code behaves the same) or harmless, copy the ledger entry the
script prints into `.mutation-survivors.json` and replace its `TODO` reason.
An entry matches on file, mutator, original and replacement text, not on line
number, so it keeps matching when the file changes elsewhere.

Locally, after `npm install`:

```bash
# which ranges would be mutated, without running Stryker
node scripts/mutation-check.mjs --base origin/main --dry-run
# the full check
node scripts/mutation-check.mjs --base origin/main
# the same, stopped with an "incomplete" notice after 20 minutes
node scripts/mutation-check.mjs --base origin/main --budget-minutes 20
# re-read reports from an earlier run against the ledger
node scripts/mutation-check.mjs --report reports/mutation/backend.json
```

Not covered yet: `scripts/` and `.claude/hooks/` (their `node --test` suites
would need Stryker's `command` runner). The frontend suite's three known
failures ([Baseline](#baseline-read-2026-10-09)) make a frontend run fail with exit `2` when the pull request
changes a file one of those tests covers.

## Where to look

```bash
# latest runs of the main gate
gh run list --repo Danathar/tududi --workflow ci.yml --limit 10
# one run, with failing steps
gh run view <run-id> --repo Danathar/tududi --log-failed
# PR metrics, current
gh pr list --repo Danathar/tududi --state all --limit 500 \
  --json number,author,state,createdAt,mergedAt,closedAt,labels,title \
  | node scripts/pr-metrics.mjs
```

## Baseline (read 2026-10-09)

| | value | source |
|---|---|---|
| backend test suites | 267 suites; 3914 passed, 8 skipped, 0 failed | `npm test` on the upstream sync branch, reported in the body of PR #10, 2026-10-06 |
| frontend unit tests | 815 passed, 3 failed (`roleLabels.test.ts`, `MarkdownRenderer.publicLinks.test.tsx`, `MermaidDiagram.test.tsx`), the three known failures on `main` | `npm run frontend:test`, same PR #10 body |
| lint | 0 errors, 12 warnings (`jest/expect-expect` in existing backend tests) | `npm run lint`, same PR #10 body |
| `ci.yml`, runs available on 2026-10-09 | 15 runs: 11 success, 1 failure, 3 without a conclusion (still running or cancelled) | command below |
| PR acceptance | see the latest file in [metrics/](metrics/README.md) | `scripts/pr-metrics.mjs` |
| coverage percentage | not recorded here; read the latest run of the coverage gate, or run `npm run test:coverage` | - |

The test counts are a person's report of a run on a specific branch, not a
measurement of `main` today; they go stale as soon as a test is added. Re-read
them with `npm test` and `npm run frontend:test` and update the date and source
here. The CI row:

```bash
gh run list --repo Danathar/tududi --workflow ci.yml --limit 30 \
  --json conclusion --jq 'group_by(.conclusion)[] | "\(.[0].conclusion): \(length)"'
```

On 2026-10-09 it printed `: 3`, `failure: 1`, `success: 11`; the empty
conclusion is a run that had not finished or had been cancelled.

## Known weak spots

- **CI does not run the frontend unit tests or the e2e suite.** A frontend
  regression can merge with a green `ci.yml`. The three known frontend
  failures above are also why the frontend suite cannot be made a gate yet.
- **Locale parity is unchecked.** English has the most keys in
  `public/locales/*/translation.json`; other locales lag and fall back to
  English. Nothing in CI reports it.
- **Acceptance rate is not a quality signal while one person is the author and
  the reviewer.** See [metrics.md](metrics.md#how-to-read-the-numbers).
- **Green CI on a stale branch.** Required checks run on the PR branch; check
  that it is current with `main` before trusting a green run.
