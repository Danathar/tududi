# AI operations runbook

For the owner. It says how to notice each automated signal in this repository,
what to check first, and what to do, and how to stop each automation.

**The fork rule comes first.** This repository is `Danathar/tududi`, a fork of
`chrisvel/tududi`. Every `gh` command that creates or changes something passes
`--repo Danathar/tududi`, and PRs and issues go to this fork, never to
`chrisvel/tududi`. See [`AGENTS.md`](../AGENTS.md), section "This repository is a
fork. All work happens here." Read-only `gh` commands below also pass the flag,
because a bare `gh` in a fork clone reads upstream.

| signal or need | section |
|---|---|
| Stop all agent work | [Pause and resume the repository in Hive](#pause-and-resume-the-repository-in-hive) |
| What does each workflow do, how do I turn it off | [What each workflow does](#what-each-workflow-does-and-how-to-turn-it-off) |
| Red `CI` on `main` | [A red `main`](#a-red-main) |
| Image on ghcr is broken | [A bad `:latest` image on ghcr](#a-bad-latest-image-on-ghcr) |
| A PR or issue exists on `chrisvel/tududi` | [A pull request or issue reached upstream](#a-pull-request-or-issue-reached-upstream) |
| A token or key appeared in a commit, log or comment | [A leaked secret](#a-leaked-secret) |
| An agent is looping or doing the wrong thing | [A runaway agent](#a-runaway-agent) |
| A scheduled run never appeared | [A scheduled run did not fire](#a-scheduled-run-did-not-fire) |

## Pause and resume the repository in Hive

Hive is outside this repository. Its per-repo pause stops agent activity on
`Danathar/tududi` only, and leaves the card on the dashboard, its counts and its
ACMM evaluation in place. It is a different switch from pausing one agent
(everywhere) or the whole fleet.

- **Dashboard:** on the repo's card under PROJECTS, the owner presses
  "pause" (it asks for a reason) or "resume".
- **API:** `POST /api/repos/pause` with `{"repo": "<name>", "reason": "..."}`,
  `POST /api/repos/resume` with `{"repo": "<name>"}`, and
  `GET /api/repos/pauses` to list. Pause and resume are owner-only.

Source: Hive's `src/docs/repo-pause.md`. Whether this repository is paused right
now is shown on the dashboard; this page does not record it.

What pausing does not do:

- It does not stop GitHub workflows. Those are switched off per workflow
  (next section).
- It does not stop the Codex connector's reviews or a local Claude Code or omp
  session.
- It does not undo anything an agent already pushed.

Confirm that Hive has stopped by looking for new bot activity:

```bash
gh pr list --repo Danathar/tududi --state all --author app/danathar-atomic-hive --limit 5 --json number,createdAt,title
```

## What each workflow does, and how to turn it off

All live in [`.github/workflows/`](../.github/workflows/). Disable one without
deleting it (this changes repository settings; it is reversible, and an
`enable` brings it back):

```bash
gh workflow disable "<workflow name>" --repo Danathar/tududi
gh workflow enable  "<workflow name>" --repo Danathar/tududi
gh workflow list --repo Danathar/tududi --all
```

Disabling a required check leaves pull requests waiting for a status that never
arrives. Disable `ci.yml` only if you also relax the ruleset (issue #42). To
remove a workflow permanently, delete the file in a pull request.

| file | what it does | trigger | turn off |
|---|---|---|---|
| `ci.yml` | `test-sqlite` (lint, backend tests, legacy SQLite upgrade, frontend build) and `test-postgres`; the checks issue #42 is to require | PR to `main`, push to `main` | `gh workflow disable "CI" --repo Danathar/tududi` |
| `docker-publish.yml` | builds per platform and pushes `ghcr.io/danathar/tududi` as `:latest`, `:sha-<short>`, `:v<version>-<short>`; refuses manual runs from any branch but `main` | push to `main`, manual | `gh workflow disable "Publish Docker image" --repo Danathar/tududi` |
| `upgrade-docker.yml` | upgrades a volume from the previous release image to an image built from the checkout and checks data, logins and backups survive | manual, `v*` tags, weekly (Monday 06:00 UTC) | `gh workflow disable "Docker upgrade test" --repo Danathar/tududi` |
| `coverage-gate.yml` | fails a PR whose coverage falls below the floors in `.coverage-thresholds.json` | pull request | disable it by its `name:` |
| `auto-qa.yml` | runs `scripts/auto-qa-tuner.mjs` against `.github/auto-qa-tuning.json` to report whether a floor should move | see the file header | disable it by its `name:` |
| `nightly-compliance.yml` | scheduled compliance checks | nightly | disable it by its `name:` |
| `pr-metrics.yml` | runs `scripts/pr-metrics.mjs` for [`metrics.md`](metrics.md) | see the file header | disable it by its `name:` |
| `agent-audit.yml` | reads back which agent PRs have `Closes #N`, a signature line and a human merger (`scripts/ai-audit-report.mjs`); a violation turns the run red | weekly, manual | `gh workflow disable "Agent audit trail" --repo Danathar/tududi` |
| `auto-issues.yml` | when `CI` or `Publish Docker image` fails on a push to `main`, opens or comments on one tracking issue per workflow; never closes one | `workflow_run` | `gh workflow disable "Auto issues" --repo Danathar/tududi` |
| `ai-fix.yml` | on label `ai-fix-requested` or comment `/ai-fix` from the owner, a member or a collaborator, asks Claude Code to verify review findings and apply those that hold; skips events sent by bots | label, comment | `gh workflow disable` by its `name:`, or never apply the label |
| `claude.yml` | answers an `@claude` mention from the owner, a member or a collaborator; refuses fork PRs; needs `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, and without one writes a summary and skips | comment | remove both secrets, or disable it by its `name:` |
| `labeler.yml` | labels PRs `area/*` from the paths they change, using [`.github/labeler.yml`](../.github/labeler.yml) | pull request | disable it by its `name:` |
| `policy-check.yml` | runs `scripts/check-policies.mjs` over `policies/` and `risk-config.json` | pull request | disable it by its `name:` |
| `agent-tooling.yml` | runs `node --test` over `scripts/tests/**/*.test.mjs` and `.claude/hooks/tests/**/*.test.mjs` | pull request | disable it by its `name:` |

The first three are on `main` at `a6225863`; the rest arrive with the ACMM pull
requests listed in [`agent-tasks/2026-10-09.md`](agent-tasks/2026-10-09.md), and
exist once those merge. A header comment at the top of each file explains its
gating; that header, not this table, is the source of truth if they differ. Get
the exact `name:` with `grep -m1 '^name:' .github/workflows/<file>`.

The agent workflows hold a write token, so they never use `pull_request_target`
and they skip bots and outsiders before doing anything. If you doubt one, disable
it first and read it afterwards.

## A red `main`

Signal: the `CI` run on a push to `main` fails, or `auto-issues.yml` opened an
issue titled for the failing workflow.

```bash
gh run list --repo Danathar/tududi --workflow ci.yml --branch main --limit 5
RUN=<run id>
gh run view "$RUN" --repo Danathar/tududi --json jobs \
  --jq '.jobs[] | {name, conclusion, failed: [.steps[] | select(.conclusion=="failure") | .name]}'
gh run view "$RUN" --repo Danathar/tududi --log-failed
```

1. **Which job.** `test-sqlite` failing on a step: lint, `backend:test`,
   `backend:test:upgrade` (legacy SQLite upgrade and schema parity) or the
   frontend build. `test-postgres` failing alone points at a Postgres-only
   difference in a migration or query.
2. **Was it the last commit or the environment.** Re-run once
   (`gh run rerun "$RUN" --repo Danathar/tududi --failed`). A pass on re-run is a
   flake; note it in the tracking issue. If a recent sync merged upstream
   changes, suspect the merge (`git log --first-parent -5 origin/main`).
3. **Fix forward or revert.** If the cause is clear, fix in a branch and pull
   request as usual. If not, revert the offending merge in a pull request
   (`git revert -m 1 <merge sha>`), because every push to `main` publishes an
   image. Do not push to `main` directly.
4. **Check the image.** A red `CI` does not stop `docker-publish.yml`, which
   runs on the same push. See the next section if `:latest` is bad.
5. **Close the tracking issue by hand** when `main` is green again;
   `auto-issues.yml` never closes one.

## A bad `:latest` image on ghcr

Signal: containers pulled from `ghcr.io/danathar/tududi:latest` misbehave, or the
publish run succeeded for a commit that turns out to be broken.

Every publish also pushes a `:sha-<short>` tag per commit (the first
seven characters of the commit; `docker-publish.yml`, step "Resolve tags").
Rollback is re-pointing `:latest` at the last good one.

1. Find the last good commit and its tag: `git log --first-parent -10 origin/main`,
   then take its first seven characters, giving `sha-<short>`.
2. Confirm that tag exists and is multi-platform:

   ```bash
   docker buildx imagetools inspect ghcr.io/danathar/tududi:sha-<short>
   ```

3. Re-point `:latest` (needs a `docker login ghcr.io` with a token that can
   write packages; this changes the published image):

   ```bash
   docker buildx imagetools create \
     -t ghcr.io/danathar/tududi:latest ghcr.io/danathar/tududi:sha-<short>
   ```

4. Deploy by the `:sha-<short>` tag until `main` is fixed. A later push to
   `main` moves `:latest` forward again, so revert or fix `main` before
   merging anything else; pause merging in Hive meanwhile.
5. The fix is a reverted or corrected commit on `main`, which republishes
   `:latest` on its own. `gh workflow run docker-publish.yml --repo Danathar/tududi --ref main`
   republishes `main`; a run from any other ref is refused by design.

Backups embed the app version (`package.json`), so a rollback within the same
upstream version is safe for restores. A rollback across an upstream sync can
meet `backend/services/backupService.js` refusing a backup newer than the image;
take a backup before you move back across a sync, not after.

## A pull request or issue reached upstream

Signal: something from this work appears on `chrisvel/tududi`, usually because a
`gh` command ran without `--repo Danathar/tududi`. Every `gh` URL should start
with `https://github.com/Danathar/tududi/`; one that does not is this case.

1. **Stop.** Do not comment, edit or explain on the upstream thread.
2. **Close it** from the web page of the upstream item, as its author
   ("Close pull request" or "Close issue", without a comment). Do not close it
   with a `gh` command: that is the one place a wrong `--repo` is the risk. If
   you cannot close it (no longer the author), tell the owner and leave it.
3. **Tell the owner** straight away, with the URL, what it contained and which
   agent or session created it. Delete the branch only if it was a fork branch
   created for that PR.
4. **Find the cause.** Check `gh repo set-default --view`, the command history,
   and whether the `upstream` push URL still reads `DISABLE`
   (`git remote -v`). Re-run `git remote set-url --push upstream DISABLE` if not.
5. Record it in the day's ledger under [`agent-tasks/`](agent-tasks/README.md).

## A leaked secret

Signal: a token, key or credential in a commit, a PR, an issue, a log or a
comment. The repository's secrets are the Anthropic credential used by
`claude.yml`/`ai-fix.yml` and any Hive or ghcr tokens the owner added;
`docker-publish.yml` itself uses only the workflow's `GITHUB_TOKEN`.

1. **Revoke first.** Rotate or delete the credential at its issuer, before
   cleaning the repository. History cleanup does not un-leak a secret that was
   public.
2. Disable the workflow that used it (table above) until a new one is set.
3. Remove it from the visible surface: edit or delete the comment or issue
   body; for a commit, a revert does not remove it from history, so the owner
   decides about rewriting history of a branch (never of `main` without a plan).
4. Replace it with `gh secret set <NAME> --repo Danathar/tududi`, run by the
   owner so the value is never in a transcript.
5. Record it in the day's ledger without the value.

## A runaway agent

Signal: a Hive agent or a workflow opening many PRs or comments, rewriting the
same files, or acting outside its issue.

1. **Pause the repository in Hive** (first section). Then disable
   `ai-fix.yml` and `claude.yml` if a workflow agent is involved.
2. **Stop what is queued.** Cancel running workflows:
   `gh run cancel <run id> --repo Danathar/tududi`; list with
   `gh run list --repo Danathar/tududi --status in_progress`.
3. **Contain the output.** Close its open pull requests
   (`gh pr close <N> --repo Danathar/tududi`) and keep the branches for
   evidence. Nothing it opened should merge: the serial lane and the
   required checks are why a runaway cannot land by volume, so confirm the
   ruleset is on (issue #42).
4. **Check what merged.** `gh pr list --repo Danathar/tududi --state merged --author app/danathar-atomic-hive --limit 20`,
   and the [`agent-audit.yml`](../.github/workflows/agent-audit.yml) summary.
   Revert anything wrong by pull request.
5. **Find why** before resuming: the issue text it followed, the instructions
   in [`AGENTS.md`](../AGENTS.md), the guard and permission settings in
   [`agent-boundaries.md`](agent-boundaries.md). Fix the instruction, not only the output.

## A scheduled run did not fire

Scheduled workflows (`upgrade-docker.yml`, and others with a `schedule:`) run
only from the default branch, can be delayed under load, and GitHub disables
schedules in a repository with no activity for 60 days. Check with
`gh workflow list --repo Danathar/tududi --all`; re-enable a disabled one with
`gh workflow enable`, and start one by hand with
`gh workflow run "<name>" --repo Danathar/tududi`.
