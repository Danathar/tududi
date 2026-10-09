# Reflections

A reflection is a dated, short account of how a piece of work in this
repository actually went, and what to do differently next time. It is for
patterns in the work itself, not for facts about the code.

**Fork rule.** This repository is `Danathar/tududi`, a fork of
`chrisvel/tududi`. Pull requests and issues go to this fork, never to
`chrisvel/tududi`; every `gh pr`, `gh issue`, `gh release` and `gh workflow`
command passes `--repo Danathar/tududi`. See [AGENTS.md](../../AGENTS.md),
section "This repository is a fork. All work happens here."

## Where things go

| Place | Holds | Lifetime |
|---|---|---|
| [AGENTS.md](../../AGENTS.md) | standing rules | durable |
| [.claude/memory/](../../.claude/memory/README.md) | one specific mistake and its rule | until no longer true |
| [.claude/session-summary.md](../../.claude/session-summary.md) | what is in flight now | overwritten each session |
| this directory | recurring patterns in how the work goes | dated, kept |

Example of the split: "`gh` in a fork clone targets the parent repo" is a
correction (memory). "Our manual test matrix is built from what the author
remembers, so reviewers find the views we forgot" is a reflection.

## When to write one

- After a PR where review or CI found something the author's own checks missed.
- After an incident, a revert, or a surprise during an upstream sync.
- When the same kind of problem has come up twice.

Do not write one for routine work that went as planned.

## Format

File name `YYYY-MM-DD-<topic>.md`. Sections:

```markdown
# <title>

**Date:** YYYY-MM-DD
**Context:** which PRs/issues/commits this is about

## What happened
Observed events only, each with a PR, commit or file reference.

## What it shows
The pattern, stated as narrowly as the evidence allows.

## What to do next time
Concrete practices. If one hardens into a standing rule, move it to AGENTS.md.
```

Rules: no event that cannot be traced to a PR, commit or file; mark guesses as
`[INFERENCE]`; link to the evidence instead of retelling it; delete or amend an
entry that later proves wrong. If a reflection produces a specific do/don't,
also add a correction in `.claude/memory/`.

## Index

| Entry | Subject |
|---|---|
| [2026-10-09-pr-9-review-findings](2026-10-09-pr-9-review-findings.md) | Review found gaps in PR #9's drag-to-area behaviour that its own browser run did not |
| [2026-10-09-fork-setup-and-upstream-sync](2026-10-09-fork-setup-and-upstream-sync.md) | What the fork setup PRs #1-#5 and the first upstream sync (PR #10) settled |
