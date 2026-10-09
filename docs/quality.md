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
