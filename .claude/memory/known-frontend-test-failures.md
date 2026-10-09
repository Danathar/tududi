# Three frontend suites already fail on main

**Date:** 2026-10-09
**Wrong:** reporting a frontend test failure as a regression from your change
(or "fixing" it with unrelated edits) without checking whether it fails on
`main` too. The reverse mistake is as bad: calling a new failure "pre-existing"
because three others are.
**Right:** `npm run frontend:test` failed these suites on `main` as reported in
PRs #9 and #10 (see Evidence); a targeted run on `a6225863` still fails all
three:
`MermaidDiagram.test.tsx`, `MarkdownRenderer.publicLinks.test.tsx` and
`roleLabels.test.ts`. Before claiming a frontend failure is not yours, run the
same suite on a clean checkout of `main` (`git stash` or a fresh worktree after
`npm ci`) and compare the set of failing suites. Any failing suite outside
this list is yours until shown otherwise. Re-verify this list: it can change
with each upstream sync, and fixing the suites should delete this entry.
**Why it matters:** CI (`.github/workflows/ci.yml`) does not run
`frontend:test`, so nothing else flags these, and a reviewer cannot tell
signal from noise without the baseline.
**Evidence:** PR #9 body, "Checks run" (3 suites fail "the same three that fail
on clean main") and "Review fix" (two of them re-checked with `git stash` on
`809b8f3`); PR #10 body, "Baseline check": on a clean checkout of `main` at
`a777f8f`, `Test Suites: 3 failed, 103 passed, 106 total`, same three names.
For this entry I ran only a targeted command on `a6225863` after `npm ci`:
`npx jest MermaidDiagram MarkdownRenderer.publicLinks roleLabels` gave
`Test Suites: 3 failed, 3 total; Tests: 3 failed, 12 passed, 15 total`. The
full `npm run frontend:test` was not re-run.
