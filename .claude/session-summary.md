# Session summary

The handoff between working sessions. Read it at the start of a session, after
[AGENTS.md](../AGENTS.md) and [CLAUDE.md](../CLAUDE.md); rewrite it at the end.
It carries only what is true right now and would otherwise have to be
rediscovered. Standing rules belong in AGENTS.md, mistakes worth never
repeating in [memory/](memory/README.md), recurring patterns in
[../docs/reflections/](../docs/reflections/README.md).

**Fork rule.** This repository is `Danathar/tududi`. Pull requests and issues
go to this fork, never to `chrisvel/tududi`; every `gh pr`, `gh issue`,
`gh release` and `gh workflow` command passes `--repo Danathar/tududi`. See
[AGENTS.md](../AGENTS.md), section "This repository is a fork. All work happens
here."

## How to use it

Start of session:

1. Read the "Current state" and the latest session entry below.
2. Verify anything you are about to rely on. Branch names, PR numbers and SHAs
   drift: check with `git log origin/main`, `gh pr list --repo Danathar/tududi`
   and `gh issue list --repo Danathar/tududi`.

End of session. This file is one tracked singleton, so concurrent PRs that all
rewrite it will conflict or overwrite each other. Rule: only the session that
lands work on `main` (the one that merges, or a dedicated handoff PR opened
after the merge) rewrites it, starting from the current `origin/main` copy. A
session that opens a PR to be merged later puts its notes in the PR body and
leaves this file alone. Steps for the session that updates it:

1. Update "Current state" so it matches what is on `main` now.
2. Replace the "Last session" entry. Overwrite it; do not append a history. What
   is worth keeping long term goes to AGENTS.md, `memory/` or `docs/reflections/`.
3. Rewrite "Open threads" and "Next steps": remove what is finished, and keep
   each remaining item to one line with its issue or PR number.
4. Record only things you observed. Mark guesses as `[INFERENCE]`.

Entry format:

```markdown
## Last session: <YYYY-MM-DD> - <one-line focus>

**Done:** what landed, with PR/issue numbers
**In flight:** open PRs, unmerged branches, half-finished work
**Blocked on:** decisions or merges needed before the next step
**Watch:** observed but not acted on
```

---

## Current state (as of 2026-10-10)

- **Base:** the last upstream sync is `a6225863`, the merge of PR #10 (upstream
  `v1.7.11`, merged as a whole tag with `git merge --no-ff`). `package.json`
  keeps upstream's version; do not bump it. On 2026-10-10 `upstream/main`
  (`4ecf6023`) was 49 commits ahead of `origin/main`. `main`'s head is not
  recorded here because it changes with every merge: read it with
  `git log -1 origin/main`.
- **Licence:** GPL-3.0-only for the fork (`LICENSE`), with upstream's MIT notice
  kept in `LICENSE.MIT`. Set up in PR #1.
- **Image:** `.github/workflows/docker-publish.yml` publishes
  `ghcr.io/danathar/tududi` from every push to `main` (PR #5):
  `:latest`, `:sha-<short>`, `:v<version>-<short>`.
- **Fork-only features:** All Tasks "Group by Area" and the project's area on
  the task page (PR #8, issue #6); drag a task from All Tasks onto a sidebar area
  to set its area (PR #9, issue #7).
- **CI:** `.github/workflows/ci.yml` runs `test-sqlite` and `test-postgres` on
  PRs to `main` and pushes to `main` (PostgreSQL image from ECR Public's Docker
  library mirror since PR #58). It does not run `npm run frontend:test`;
  `coverage-gate.yml` runs the frontend suite for coverage and tolerates its
  known failures.
- **Branch protection:** ruleset `protect main` (id 24817503) is active: pull
  requests only, `test-sqlite` and `test-postgres` required, branch up to date
  with `main`. See [../docs/branch-protection.md](../docs/branch-protection.md).
- **Known failing frontend suites on `main`:** `MermaidDiagram.test.tsx`,
  `MarkdownRenderer.publicLinks.test.tsx`, `roleLabels.test.ts`
  (see [memory/known-frontend-test-failures.md](memory/known-frontend-test-failures.md)).
- **Agent tooling:** all ACMM tickets except #42 are closed by PRs #49-#57,
  #59 and #60 (outcomes and merge commits in
  [../docs/agent-tasks/2026-10-09.md](../docs/agent-tasks/2026-10-09.md)).
  `.claude/settings.json` runs `.claude/hooks/guard-bash.mjs` before every Bash
  call; `policy-check.yml` enforces `policies/` on every PR.
- **Hive:** the owner's agent orchestrator works this repo through its GitHub
  App; the repo was paused in Hive while the ACMM tickets were worked (stated
  by the owner, not checked from this repository). #42 waits on setting this
  repo's Hive `merge_strategy` to `hive-serialized`.
- **Secrets:** `claude.yml` and `ai-fix.yml` skip their agent step until one of
  `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` is added as a repository
  secret.

## Last session: 2026-10-09 - ACMM tickets #11-#48

**Done:** PRs #49-#60 merged (#58 moved CI's PostgreSQL image off Docker Hub,
#60 closed two hook gaps found in review); ruleset 24817503 applied; labels
`ai-fix-requested` and `area/*` created for `ai-fix.yml` and `labeler.yml`.
**In flight:** nothing.
**Blocked on:** the owner setting Hive's merge strategy for #42.
**Watch:** `npm audit` reported one high and one critical production advisory
when `nightly-compliance.yml` was written (report-only there); not triaged.

## Open threads

- Codex review on PR #9 (P2, `Tasks.tsx:90` at `809b8f3`) said the
  `isAllTasksView` predicate lets area drops through on the Completed filter
  (`status=completed`) and on "Assigned to me" (`assigned_to=me&status=active`,
  `SidebarNav.tsx:87`). Commit `b6aba6fb` changed only `areaDrop.ts`, and
  `frontend/components/Tasks.tsx:85-90` on `a6225863` still tests
  `status !== 'done'` only. Not reproduced here; decide whether to fix it. See
  [../docs/reflections/2026-10-09-pr-9-review-findings.md](../docs/reflections/2026-10-09-pr-9-review-findings.md).
- `.claude/hooks/guard-bash.mjs` is a guard against careless commands, not a
  sandbox (threat model at the top of the file). One known P3 gap: a
  `git config rename-section <x> core` can carry a `sshCommand` into `core`.

## Next steps

1. Set Hive's merge strategy for `tududi` to `hive-serialized` and close #42.
2. Settle the PR #9 predicate question above.
3. Next upstream sync is manual (AGENTS.md: no scheduled sync). Follow the PR #10
   method: merge the whole tag, run the checks, list the migrations.
