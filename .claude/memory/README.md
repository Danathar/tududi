# Correction memory

One file per correction: a mistake an agent made, or nearly made, in this
repository, the rule that prevents it, and the evidence. The conversation that
produced a mistake is gone by the next session; these files are what is left.

**Fork rule.** This repository is `Danathar/tududi`, a personal fork of
`chrisvel/tududi`. Pull requests, issues, comments and labels go to this fork
and never to `chrisvel/tududi`. Every `gh pr`, `gh issue`, `gh release` and
`gh workflow` command passes `--repo Danathar/tududi`, and PRs also pass
`--base main --head <branch>`. See [AGENTS.md](../../AGENTS.md), section "This
repository is a fork. All work happens here." The first entry below is that
rule's origin.

## What goes here

- Something an agent got wrong, or came within one step of getting wrong, that
  is easy to repeat and hard to see from the code alone.
- Not here: standing rules that apply to all work (those are in
  [AGENTS.md](../../AGENTS.md)), what is in flight right now (that is
  [../session-summary.md](../session-summary.md)), and patterns in how the
  work goes (those are [../../docs/reflections/](../../docs/reflections/README.md)).
  A correction that hardens into a standing rule is promoted to AGENTS.md; the
  entry stays as the reason behind the rule.

## Naming and format

`<kebab-case-topic>.md`, one correction per file, in this shape:

```markdown
# <short title>

**Date:** YYYY-MM-DD (when it was recorded)
**Wrong:** what was done or assumed
**Right:** what is true / what to do
**Why it matters:** the consequence of repeating it
**Evidence:** commit, PR or file:line that shows it
```

Evidence must be something a reader can open. A claim that cannot be checked
against a commit, a PR or a file does not get an entry.

## When to add and retire

- Add an entry in the same PR that fixes the mistake, or at the end of the
  session in which it was caught. Check the index below first and extend an
  existing entry rather than adding a near-duplicate.
- Re-verify an entry before relying on it: line numbers and test lists drift.
  If it is no longer true, delete the file in the PR that makes it untrue.
  A stale correction is worse than none.
- Add the new file to the index below.

## Index

| Entry | One line |
|---|---|
| [gh-defaults-to-upstream](gh-defaults-to-upstream.md) | `gh` in a fork clone targets `chrisvel/tududi` unless told otherwise |
| [no-package-version-bump](no-package-version-bump.md) | Never bump `package.json` version; backup restore compares it |
| [license-mit-verbatim](license-mit-verbatim.md) | `LICENSE.MIT` stays byte-identical to upstream's notice |
| [dialect-safe-migrations](dialect-safe-migrations.md) | Migrations must run on SQLite and PostgreSQL |
| [known-frontend-test-failures](known-frontend-test-failures.md) | Three frontend suites already fail on main; verify before claiming a regression |
| [hosted-only-upstream-code](hosted-only-upstream-code.md) | Do not patch upstream's hosted-mode (Cloud) code in this fork |
