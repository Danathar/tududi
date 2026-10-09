# How several agents share this repository

More than one AI agent works in `Danathar/tududi`, next to its owner. This page
says which agents, how work reaches them, what keeps them from colliding, and
who decides what lands. [`AGENTS.md`](../AGENTS.md) is the brief every agent
reads first and wins on any disagreement; [`CLAUDE.md`](../CLAUDE.md) is the
codebase guide. This page is about how the agents fit together, not about how
to write code here.

It holds no counts, because they go stale. Where a fact can change, a command
shows the current answer.

## Rule 1: this is a fork, and everything stays here

This repository is `Danathar/tududi`, a fork of `chrisvel/tududi`. Every pull
request, issue, comment, label and push goes to this fork, never to
`chrisvel/tududi`. In a fresh clone, creating a pull request or issue with `gh` and no
repository flag targets upstream, so every `gh` command passes `--repo Danathar/tududi`:

```bash
gh pr create --repo Danathar/tududi --base main --head <branch> --title "<title>" --body-file <file>
gh issue comment <N> --repo Danathar/tududi --body-file <file>
```

Check that each URL `gh` prints starts with `https://github.com/Danathar/tududi/`.
Push only to `origin`; the `upstream` remote is for `git fetch` and its push URL
is `DISABLE`. The full rule, including what to do after a mistake, is in
[`AGENTS.md`](../AGENTS.md) under "This repository is a fork. All work happens
here." and in [`ai-ops-runbook.md`](ai-ops-runbook.md#a-pull-request-or-issue-reached-upstream).
No agent, Hive included, may open anything upstream unless the owner asks for
that specific action.

## There is no dispatcher in this repository

Nothing here decides which agent runs, when, or on what. [Hive](https://github.com/hivecommons/hive)
does that from outside, through a GitHub App, and its dashboard is not part of
this repository. Workflows in `.github/workflows/` react to ordinary GitHub
events (a push, a pull request, a label, a comment, a schedule); they do not
schedule an agent on their own. What each one does is in
[`ai-ops-runbook.md`](ai-ops-runbook.md#what-each-workflow-does-and-how-to-turn-it-off).

## Who works here

| who | how to recognise it | what it does |
|---|---|---|
| The owner (`Danathar`) | commits and PRs under that login | decides scope, merges, syncs upstream by hand |
| Hive agents | PRs and issues from the GitHub App `danathar-atomic-hive` (`gh` prints the author as `app/danathar-atomic-hive`, the REST API as `danathar-atomic-hive[bot]`); the body ends with a line like `— hive: agent=<name>` | pick up issues, open PRs, reply to review |
| Codex connector | review comments from `chatgpt-codex-connector[bot]` | reviews pull requests and grades findings P0 to P3 |
| Local agents | Claude Code or omp sessions in a clone on the owner's machine; commits carry the owner's git identity | work one issue on one branch, as the owner directs |

Match the Hive login exactly, not "any bot": `github-actions[bot]` also acts
here. Three ways to see who did what:

```bash
# PRs the Hive app opened
gh pr list --repo Danathar/tududi --state all --author app/danathar-atomic-hive --json number,title,headRefName

# the signature line on one PR
gh pr view <N> --repo Danathar/tududi --json author,body \
  --jq '.author.login, (.body | split("\n") | map(select(startswith("— hive: "))))'

# reviews left by the Codex connector on one PR
gh api repos/Danathar/tududi/pulls/<N>/reviews \
  --jq '.[] | select(.user.login == "chatgpt-codex-connector[bot]") | .body'
```

Findings from the Codex connector carry a priority from P0 (blocking) to P3
(minor). Read each one against the code before acting: a finding is a claim to
verify, not an instruction. See [`review-rubric.md`](review-rubric.md) for the
checklist a reviewer, human or agent, applies.

Task traceability, which links a change back to the agent task that produced
it, is described in [`agent-tasks/README.md`](agent-tasks/README.md).

## How work reaches an agent

- **An issue.** Hive reads issues and files its own. ACMM issues carry the
  title prefix `[ACMM L<n>]`.
- **A label or comment** that a workflow reacts to, such as `ai-fix-requested`
  or an `@claude` mention (on an issue comment, a PR comment or a PR review
  comment). These are defined by `.github/workflows/ai-fix.yml` and
  `.github/workflows/claude.yml`, added by PR #49 and not on `main` until it
  merges; read the header of each for who may trigger it.
- **Hive's own schedule**, outside this repository. When the repo is paused in
  Hive, its agents stop acting on it (see
  [`ai-ops-runbook.md`](ai-ops-runbook.md#pause-and-resume-the-repository-in-hive)).

## What keeps agents from colliding

There is no lock. Agents work on separate branches; collisions are found by
reading and settled by the owner.

1. **Claim before you start.** Look for an open pull request or a branch that
   already answers the issue, and for a claim comment on it:

   ```bash
   gh pr list --repo Danathar/tududi --state open --json number,title,headRefName
   gh issue view <N> --repo Danathar/tududi --comments
   ```

   If another agent holds the issue, do not start a second branch for it.
   Say in your pull request body which files you touch and which open pull
   requests you checked them against.
2. **One branch per issue.** A pull request answers one issue (or one named
   group of issues) and says so with `Closes #N`. Branch names say what they
   do (Hive names its own branches; do not rely on a pattern): the ACMM effort used `acmm/<slug>` (see
   [`agent-tasks/2026-10-09.md`](agent-tasks/2026-10-09.md)). Branch from
   current `origin/main`; do not stack one branch on another.
3. **Never push to a branch you did not create.** That includes another
   agent's branch and an outside contributor's. Comment instead.
4. **Keep shared files small and mine.** Files every change tends to touch are
   conflict hot spots:
   - `AGENTS.md`, `CLAUDE.md`, `README.md`, `package.json`, `package-lock.json`
     and `.github/workflows/ci.yml` change only in a pull request that exists
     to change them.
   - **Migrations.** Files in `backend/migrations/` are named
     `<YYYYMMDDNNNNNN>-<name>.js` and run in name order (the newest begin
     `20261005…`). Create one with `npm run migration:create <name>` (the script takes the name as its first
     positional argument; `--name` would be taken as the name itself),
     and give it a timestamp later than every migration already on `origin/main`.
     Never edit a migration that is on `main`; add a new one. Before you push,
     rebase on `origin/main` and confirm no other branch took your number.
   - **Locales.** Translations live in `public/locales/<lang>/translation.json`
     (`en` is the source). A new string goes into `en` first; several branches
     adding keys to the same JSON file conflict on neighbouring lines, so
     rebase and resolve by keeping both keys.
   - **`package.json` version.** Never bump it; it arrives from upstream with a
     sync ([`AGENTS.md`](../AGENTS.md), "Docker images").
5. **Rebase, do not merge `main` into your branch.** If `main` moved, rebase and
   re-run the checks that matter for your change.

## Who decides what lands

No agent merges its own pull request unless the owner has set that up.

- **Required checks.** The checks meant to gate a merge are the two jobs in
  [`ci.yml`](../.github/workflows/ci.yml): `test-sqlite` (lint, backend tests,
  legacy SQLite upgrade, frontend build) and `test-postgres`. They run on every
  pull request, but they are not enforced until the ruleset in issue #42 (an
  owner settings change, not a pull request) is turned on; until then `main` is
  unprotected. Check with
  `gh api repos/Danathar/tududi/rulesets --jq '.[].name'`.
- **Serialized merging (intended, per issue #42).** The intended merge lane is
  Hive's serialized one (`merge_strategy: hive-serialized`): one pull request at
  a time, each brought up to date with `main` and re-tested before it merges.
  Selecting it is an owner settings change that issue #42 tracks and that had
  not been applied when this page was written; check the Hive settings for the
  current value. GitHub's native merge queue is not available to a
  personal-account repository, which is why the lane lives in Hive rather than
  in a workflow here.
- **Green is only trusted on a current branch.** A pull request that passed
  before `main` moved has not been tested against today's `main`. Rebase first.
- **Image publishing follows merging.** Every push to `main` publishes
  `ghcr.io/danathar/tududi` ([`docker-publish.yml`](../.github/workflows/docker-publish.yml)),
  so a merge is a release. That is the reason for the serial lane and for the
  runbook's [bad `:latest`](ai-ops-runbook.md#a-bad-latest-image-on-ghcr) section.
- **An agent's permission boundary needs the owner.** Changes to
  `.claude/settings.json`, `.claude/hooks/**`, `policies/` or
  `.github/CODEOWNERS` are read and merged by the owner, whoever wrote them. An
  agent must not widen its own boundary ([`agent-boundaries.md`](agent-boundaries.md),
  [`security/SECURITY-AI.md`](security/SECURITY-AI.md)).
- **Risk tiers set how hard the owner looks.** See
  [`risk-tiers.md`](risk-tiers.md).
- **Upstream sync is manual.** The owner brings upstream changes in by hand
  ([`strategy.md`](strategy.md)). Agents do not add a scheduled sync.

## If you are an agent

1. Read [`AGENTS.md`](../AGENTS.md), then [`CLAUDE.md`](../CLAUDE.md).
2. Pass `--repo Danathar/tududi` on every `gh` write command.
3. Claim the issue, branch from `origin/main`, one branch per issue.
4. Run the checks for the files you changed; say in the PR which you ran and
   which you did not.
5. Leave the merge to the lane and the owner.
