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

## Current state (as of 2026-10-09)

- **Base:** the last upstream sync is `a6225863`, the merge of PR #10 (upstream
  `v1.7.11`, merged as a whole tag with `git merge --no-ff`). `package.json`
  keeps upstream's version; do not bump it. `main` has moved since: PR #58
  (`5306e5b8`) pulls the PostgreSQL CI service image from ECR Public's Docker
  library mirror (`.github/workflows/ci.yml`), and PR #52 (`d36df5a1`) added the
  agent direction files. Other ACMM PRs land on top of it. `main`'s head is not
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
  PRs to `main` and pushes to `main`. It does not run `npm run frontend:test`.
- **Known failing frontend suites on `main`:** `MermaidDiagram.test.tsx`,
  `MarkdownRenderer.publicLinks.test.tsx`, `roleLabels.test.ts`
  (see [memory/known-frontend-test-failures.md](memory/known-frontend-test-failures.md)).
- **Agent tooling:** the ACMM tickets #11-#48 on `Danathar/tududi` ask for agent
  and automation scaffolding. They are being worked as separate PRs from
  worktrees under `~/workspace/tududi-wt/<slug>` (branch `acmm/<slug>`); PRs
  #49 and #50 were open when this was written. Which of them have merged is not
  recorded here: check the issue list.
- **Hive:** the owner's agent orchestrator works this repo through its GitHub
  App; the repo is paused in Hive as of this writing (stated by the owner, not
  checked from this repository).
- **Gotcha:** `.gitignore:17` has `.claude*`, so new files under `.claude/` need
  `git add -f` until that line is changed.

## Last session: 2026-10-09 - learning artifacts for the ACMM tickets

**Done:** added `.claude/memory/` (#17), this file (#23, #32) and
`docs/reflections/` (#33, #38), written from the history of PRs #1-#10 and from
AGENTS.md. Entries were checked against the commits, PR bodies and files they
cite. The three frontend failures were re-run on `a6225863`.
**In flight:** the PR that adds these files (branch `acmm/learning-artifacts`),
and the other ACMM PRs.
**Blocked on:** owner review and merge of the ACMM PRs.
**Watch:** see Open threads.

## Open threads

- Codex review on PR #9 (P2, `Tasks.tsx:90` at `809b8f3`) said the
  `isAllTasksView` predicate lets area drops through on the Completed filter
  (`status=completed`) and on "Assigned to me" (`assigned_to=me&status=active`,
  `SidebarNav.tsx:87`). Commit `b6aba6fb` changed only `areaDrop.ts`, and
  `frontend/components/Tasks.tsx:85-90` on `a6225863` still tests
  `status !== 'done'` only. Not reproduced here; decide whether to fix it. See
  [../docs/reflections/2026-10-09-pr-9-review-findings.md](../docs/reflections/2026-10-09-pr-9-review-findings.md).
- `.gitignore` swallows `.claude/` and `.cursor` paths (see Gotcha above).

## Next steps

1. Review and merge the ACMM PRs; close the issues each PR names with `Closes #N`.
2. Settle the PR #9 predicate question above.
3. Next upstream sync is manual (AGENTS.md: no scheduled sync). Follow the PR #10
   method: merge the whole tag, run the checks, list the migrations.
