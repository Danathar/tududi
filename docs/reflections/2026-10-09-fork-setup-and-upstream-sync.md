# What the fork setup PRs and the first upstream sync settled

**Date:** 2026-10-09
**Context:** PRs #1-#5 (relicense, AGENTS.md, README, ghcr publishing) and PR
#10 (upstream `v1.7.8`-`v1.7.11` sync, merged as `a6225863`).

## What happened

- PR #1 relicensed the fork to GPL-3.0-only, kept upstream's MIT notice in
  `LICENSE.MIT` (byte-identical to the old `LICENSE`), and added `AGENTS.md` with
  the rule that work stays in this fork and the `gh` default-repository trap.
- PR #5 replaced upstream's release plumbing with `docker-publish.yml` that
  pushes `ghcr.io/danathar/tududi`. The PR body records two Codex P1 findings
  fixed in `24d3e3ef` ("publish only from main, on every main commit, with a
  version tag"), says `actionlint` passed, and says the workflow had not run:
  it "first runs when this merges to `main`". The same PR recorded in AGENTS.md
  why `package.json` keeps upstream's version (restore check in
  `backend/services/backupService.js`).
- PR #10 merged the whole `v1.7.11` tag (`git merge --no-ff`, no conflicts)
  instead of cherry-picking, listed the three upstream migrations
  (`20261005000001`-`3`), and ran all three on a fresh database.
- PR #10's first version said the three failing frontend suites matched the known
  list but that main had not been re-run. A "Baseline check (added after
  review)" section then ran `npx jest` on a clean `main` at `a777f8f`: 3 failed,
  103 passed, same three names.
- Codex raised a P1 (30-day trial text) and a P2 (reminder marked sent early) on
  upstream's hosted-mode code. The PR left both unpatched and said why: the code
  is gated on hosted mode and cannot run on this instance, and patches would
  conflict at every sync.

## What it shows

- Each fork-level decision in AGENTS.md has a reason written beside it (backup
  restore check, image tags, no scheduled sync), which lets a later agent apply
  the rule and not guess at it.
- Claims about a baseline are stronger when the baseline was actually run: PR
  #10 started with an inference ("identical to the known list") and ended with
  a measurement.
- Reading a review finding against reachability (does this code run here?) is a
  legitimate outcome, provided the PR says so.
- A workflow nobody has run is still unverified after lint; PR #5 said so
  plainly.

## What to do next time

- For the next upstream sync, repeat PR #10's structure: merge the whole tag,
  list upstream migrations and whether they ran, run the baseline on `main`
  before calling failures pre-existing, and answer each automated review finding.
- Put the reason next to each new fork rule in AGENTS.md.
- State in the PR when a workflow change has not been executed, and what will
  exercise it first.
