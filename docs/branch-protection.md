# Branch protection and serialized merging

`main` is what `.github/workflows/docker-publish.yml` builds and pushes to
`ghcr.io/danathar/tududi` as `:latest` on every push. This page says what
protects it, why, and how to check that GitHub is really enforcing it.

This repository is a fork. Every command here targets `Danathar/tududi`; never
`chrisvel/tududi`. See [AGENTS.md](../AGENTS.md).

## Status

The ruleset in [`.github/rulesets/main.json`](../.github/rulesets/main.json) is
**active**. It was applied on 2026-10-09 as ruleset `24817503`, and the live
rules match the committed file. Check it yourself; neither
call needs admin rights:

```bash
gh api repos/Danathar/tududi/branches/main --jq .protected
gh api repos/Danathar/tududi/rulesets --jq '.[] | "\(.id) \(.name) \(.enforcement)"'
```

The first prints `true`; the second lists `protect main` as `active`. Anything
else means the ruleset was removed or disabled and `main` again accepts a
direct push from any token with `contents: write`.

Being active does not prove the rules are the ones in the file; an edit in the
GitHub UI could leave only `deletion`. Compare the live ruleset with the file
(prints nothing when they match):

```bash
diff <(gh api repos/Danathar/tududi/rulesets/24817503 \
         --jq '{name,target,enforcement,conditions,bypass_actors,rules}' | jq -S .) \
     <(jq -S '{name,target,enforcement,conditions,bypass_actors,rules}' \
         .github/rulesets/main.json)
```

GitHub fills in defaults for `pull_request` parameters that were not sent
(`require_extra_approval_for_unattributed_changes: true`,
`required_reviewers: []`); the file spells them out so this diff stays empty.

## Why

Every gate this repository has sits behind a pull request: the `CI` workflow,
the review rubric, the risk tiers, the agent-facing policy checks. Nothing made
anyone open one. Two kinds of token can write `main` without a person reading
the change:

- The Hive GitHub App (`danathar-atomic-hive`), which pushes branches for
  agents that read issue and pull request text written by others.
- Workflows that hold `contents: write`.

A direct push to `main` is published as `:latest` within minutes.

## The ruleset

[`.github/rulesets/main.json`](../.github/rulesets/main.json) is in GitHub's
import format, so it applies as-is.

- **Targets `~DEFAULT_BRANCH`**, so it follows a rename of `main`.
- **No bypass actors.** A bypass for Actions or for an App hands back the
  direct push this exists to stop.
- **`deletion` and `non_fast_forward`** stop `main` being deleted or rewritten.
- **`pull_request` with 0 approvals.** GitHub does not let anyone approve their
  own pull request, so on a single-maintainer repository one required approval
  would mean nothing can ever merge. What 0 still enforces is that every change
  arrives as a pull request that passed the required checks. It does not make
  the merger a person: a token that can write contents could merge a green
  pull request through the API.
- **Two required checks, `test-sqlite` and `test-postgres`.** They are the two
  jobs in [`ci.yml`](../.github/workflows/ci.yml), which runs on every pull
  request to `main` with no path filter, so no pull request waits for a check
  that never starts. `integration_id` 15368 is GitHub Actions. Renaming either
  job, or giving `ci.yml` a path filter, blocks every merge until this file and
  the live ruleset are updated to match.
- **A pull request merges only with `main`'s current head in it**
  (`strict_required_status_checks_policy: true`). The required checks have
  then run on what will land, not on a stale base.

Upstream syncs land the same way as everything else: as a pull request from a
`sync/upstream-*` branch (for example #10).

## Merge queue

GitHub's merge queue is offered only to repositories owned by an organization,
and this one is under a personal account, so the ruleset has no `merge_queue`
rule. The same guarantee comes from two pieces together:

1. The up-to-date rule above: every pull request carries `main`'s current head
   and has passed `test-sqlite` and `test-postgres` on it.
2. Hive's serialized merge lane (`merge_strategy: hive-serialized`): Hive merges
   one pull request at a time and re-validates the next one against the new
   `main`, so two agent pull requests that pass on their own cannot break
   `main` together.

The ACMM evaluation credits its Merge queue criterion when both hold. The Hive
side is a setting on the Hive dashboard (ACMM evaluation, Merge queue row for
`tududi`, **Use serialized merge lane**), not a file in this repository. It has
been `hive-serialized` since 2026-10-10; an authenticated
`GET /api/repos/merge-strategy?repo=tududi` on the Hive dashboard API reads it
back.

## Applying or changing the ruleset

A pull request cannot change repository settings; a repository admin applies
the file. First time:

```bash
gh api --method POST repos/Danathar/tududi/rulesets \
  --input .github/rulesets/main.json
```

To change it, edit the file in a pull request, then after it merges update
the live ruleset from the file:

```bash
gh api --method PUT repos/Danathar/tududi/rulesets/24817503 \
  --input .github/rulesets/main.json
```

### Renaming a required check

That order deadlocks when the pull request renames `test-sqlite` or
`test-postgres` (or the `ci.yml` job behind it): the pull request reports only
the new name while the live ruleset waits for the old one, so it can never
merge. Stage it instead:

1. Open the pull request that renames the job and changes
   `.github/rulesets/main.json` to the new name. Wait for its new check to pass.
2. While it is open, PUT the file from that branch to the live ruleset (the
   command above, run in a checkout of the branch). The pull request can now
   merge on its new check.
3. Merge it, then run the diff above against `main` to confirm the live rules
   and the file agree.

No other pull request can merge between steps 2 and 3: until the rename is on
`main`, their CI still reports the old name. Do step 3 straight after step 2;
after it, each open pull request merges `main` and needs one CI run, which the
up-to-date rule requires anyway.

## When there is a second reviewer

Set `required_approving_review_count` to 1 and consider
`require_last_push_approval`, so a push after approval needs a fresh one.
