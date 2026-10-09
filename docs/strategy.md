# Strategy

This page says why `Danathar/tududi` exists, what it deliberately does not do,
which goals are measured and where, and what the measurements said on the date
below. Rules for agents are in [`AGENTS.md`](../AGENTS.md); how agents share the
repository is in [`multi-agent.md`](multi-agent.md).

Every `gh` command here passes `--repo Danathar/tududi`. This repository is a
fork, and in a clone that has the parent as `upstream`, a bare `gh` reads the
parent instead.

## Why this fork exists

From [`README.md`](../README.md) and [`AGENTS.md`](../AGENTS.md):

- **A personal fork.** It is a customised copy of
  [`chrisvel/tududi`](https://github.com/chrisvel/tududi), tailored for its
  owner. It is not meant to replace upstream, and issues about the fork belong
  here. Nothing done here goes upstream unless the owner asks for a specific
  upstream action.
- **GPL-3.0-only.** The fork is relicensed under GPL-3.0 ([`LICENSE`](../LICENSE));
  the upstream MIT notice travels with the upstream code in
  [`LICENSE.MIT`](../LICENSE.MIT) and the README's License section. Neither
  may be removed or reverted.
- **Its own container image.** Every push to `main` publishes
  `ghcr.io/danathar/tududi` as `:latest`, `:sha-<short commit>` and
  `:v<version>-<short commit>`
  ([`docker-publish.yml`](../.github/workflows/docker-publish.yml)). Upstream's
  Docker Hub image, tag-driven releases and deploy workflow are not used.
- **Hand-synced upstream.** The owner brings upstream changes in manually (the
  last one is merge #10, "chore: sync upstream v1.7.8-v1.7.11"). There is no
  scheduled sync, and the fork has no version line of its own: `package.json`
  keeps upstream's version, because backups embed it and
  `backend/services/backupService.js` refuses to restore a backup newer than the
  running app.
- **Agents help maintain it.** The owner uses AI agents (Hive agents, the Codex
  connector, local Claude Code or omp sessions) to build and review changes.
  The ACMM issues (`[ACMM L0]` to `[ACMM L6]`) are the scaffolding that makes
  that safe and auditable.

## What it will not do

- Send work upstream, or push anywhere but `origin`.
- Bump the package version, switch to CalVer, or add a version suffix.
- Relicense back to MIT, or drop the upstream MIT notice.
- Add a scheduled upstream sync or an upstream-style release workflow.
- Let an agent merge its own pull request or widen its own permissions
  ([`multi-agent.md`](multi-agent.md)).

## Measurable goals

Each goal names the place it is measured. "Now" means the answer changes as the
repository does; run the command for today's answer.

| goal | measured by | where |
|---|---|---|
| Reach and hold the target ACMM level | the ACMM evaluator's result for this repo, one file or directory per criterion; open criteria are the `[ACMM L<n>]` issues | `gh issue list --repo Danathar/tududi --state open --limit 200` (titles start with `[ACMM`) |
| `main` stays green | `test-sqlite` and `test-postgres` on pushes to `main` | `gh run list --repo Danathar/tududi --workflow ci.yml --branch main --limit 10 --json createdAt,conclusion` |
| Tests do not lose coverage | per-area floors | [`.coverage-thresholds.json`](../.coverage-thresholds.json), enforced by [`coverage-gate.yml`](../.github/workflows/coverage-gate.yml); a floor guards against regression, it is not a target to climb |
| Change flow is visible | PR counts, review findings, CI outcomes, read by `scripts/pr-metrics.mjs` | [`metrics.md`](metrics.md), dated snapshots in [`metrics/`](metrics/) |
| The published image tracks `main` | newest `docker-publish.yml` run on `main` succeeded; `:sha-<short>` matches `main` | `gh run list --repo Danathar/tududi --workflow docker-publish.yml --branch main --limit 5` |
| Upstream sync lag stays known | commits on `upstream/main` that `origin/main` lacks | below |
| Agent work is traceable | every agent PR has `Closes #N`, a signature line and a human merger | [`agent-tasks/`](agent-tasks/README.md), the `agent-audit.yml` run summary |

None of these is a velocity target. Throughput and coverage percentage are not
goals; optimising them would mean rushing review or padding tests.

### Upstream sync lag

The lag is how many commits `upstream/main` has that `origin/main` lacks. Fetch
first, because the number is only as fresh as the last fetch:

```bash
git fetch upstream
git rev-list --left-right --count origin/main...upstream/main
# prints: <commits only on origin/main>  <commits only on upstream/main>
git merge-base origin/main upstream/main
git describe --tags upstream/main
```

The second number is the lag. Syncing is the owner's decision and happens by
hand; a growing lag is information, not an alarm.

## Status on 2026-10-09

Read on 2026-10-09 at `origin/main` = `a6225863` (merge of PR #10). Left as it
was read; the next reading is a new dated section or file, not an edit.

| measure | reading | how it was read |
|---|---|---|
| Upstream sync lag | 49 commits behind; `upstream/main` = `4ecf6023` (`v1.8.2-1-g4ecf6023`, committed 2026-10-09); merge base `0e141330` (upstream release v1.7.11); 18 commits on `origin/main` not in upstream | `git fetch upstream && git rev-list --left-right --count origin/main...upstream/main` printed `18 49` |
| CI on `main` | last 5 runs of `ci.yml` on `main` all `success` (newest 2026-10-06T15:00:15Z) | `gh run list --repo Danathar/tududi --workflow ci.yml --branch main --limit 5` |
| Branch protection | at the first reading of the day `main` was unprotected with no rulesets; later the same day the ruleset `protect main` (id 24817503) was active, requiring `test-sqlite` and `test-postgres` with up-to-date branches; see [`branch-protection.md`](branch-protection.md) (PR #59). Hive's `merge_strategy` is not set yet | `gh api repos/Danathar/tududi/rulesets` |
| Workflows on `main` | `ci.yml`, `docker-publish.yml`, `upgrade-docker.yml` | `.github/workflows/` at `a6225863`; the rest arrive with the ACMM pull requests in [`agent-tasks/2026-10-09.md`](agent-tasks/2026-10-09.md) |
| Coverage floors | none yet: `.coverage-thresholds.json` does not exist at `a6225863` (issue #11) | file absent |
| ACMM | 38 open `[ACMM L<n>]` issues (#11 to #48), one per missing criterion. The evaluator's current level was not read for this page: see the Hive dashboard card | `gh issue list --repo Danathar/tududi --state open` |
| Open pull requests | 1 (`acmm/pr-automation`) at the first reading; 9 (#49 to #57, the `acmm/*` branches) when re-read later the same day | `gh pr list --repo Danathar/tududi --state open` |
| Fork version | `package.json` `version` is `v1.7.11`, upstream's | `package.json:3` |

## Keeping this page honest

Do not put a number here that a later commit can make false without dating it.
The status table is a dated reading; everything above it is commands and
reasons. When you change a command, run it and check it prints what the text
says.
