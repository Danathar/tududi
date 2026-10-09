# gh defaults to upstream in a fork clone

**Date:** 2026-10-09
**Wrong:** running a bare `gh pr create`, `gh issue create` or `gh pr comment`
in a clone of this fork. GitHub CLI treats the fork's parent as the default
repository, so the command targets `chrisvel/tududi`. No incident is recorded
in the history; AGENTS.md was written to prevent it.
**Right:** pass `--repo Danathar/tududi` to every `gh pr`, `gh issue`,
`gh release` and `gh workflow` command. For PRs also pass `--base main --head
<branch>`:

```bash
gh pr create --repo Danathar/tududi --base main --head <branch> --title "<title>" --body-file <file>
```

Check that every URL `gh` prints starts with `https://github.com/Danathar/tududi/`.
If it does not, stop, close what was created, and tell the owner. Push only to
`origin`; fetch from `upstream` only
(`git remote set-url --push upstream DISABLE`).
**Why it matters:** a PR or comment on `chrisvel/tududi` is public, lands on a
project the owner does not speak for, and cannot be unsent.
**Evidence:** [AGENTS.md](../../AGENTS.md) section "The `gh` default-repository
trap"; PR #1 body ("`AGENTS.md` (new...) ... covers the `gh` trap where
commands default to the parent repo"); PR #1 is merge commit `15792362`.
