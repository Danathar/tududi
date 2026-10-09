# PR metrics

What this fork measures about its own pull-request flow, how each number is
defined, and how to recompute it. The numbers change daily; the definitions
and commands here are the durable part. Dated readings live in
[`docs/metrics/`](metrics/README.md).

This repository is `Danathar/tududi`, a fork. In a clone whose parent is
`chrisvel/tududi`, a bare `gh pr list` reads the parent, so every command
below passes `--repo Danathar/tududi`. See [AGENTS.md](../AGENTS.md), section
"This repository is a fork. All work happens here."

## What is computed

[`scripts/pr-metrics.mjs`](../scripts/pr-metrics.mjs) reads the JSON that
`gh pr list` prints and reports, for each window and each author class:

| metric | definition |
|---|---|
| merged | PRs with a `mergedAt` timestamp |
| closed unmerged | closed PRs with no `mergedAt` |
| open | PRs still open when the report is generated |
| acceptance rate | merged / (merged + closed unmerged). Open PRs are not decided yet and are left out. `n/a` when nothing is decided |
| time to merge | `mergedAt - createdAt` of merged PRs. Median (mean of the two middle values when the count is even) and p90 (nearest rank, no interpolation) |

Windows: **all time**, and the **last 30 days** (`--window-days` changes the
30). A merged or closed PR belongs to a window when it was merged or closed at
or after the window start (inclusive) and not after the report time. Its
creation date does not matter, so a PR opened 40 days ago and merged
yesterday counts as "last 30 days" and its 40-day wait counts in that window's
time to merge. Open PRs have no decision date, so they appear as open in every
window.

Author classes, from the `author` object `gh` prints:

| class | who |
|---|---|
| owner | the repository owner's account (`Danathar`, `--owner` changes it) |
| Hive app | the Hive GitHub App, `app/danathar-atomic-hive` (also `danathar-atomic-hive[bot]`) |
| other bots | any other app or bot account: `app/dependabot`, the Codex connector, and so on |
| other humans | any other non-bot account |

The split exists because the rate means different things per class: the owner
merges their own PRs, while Hive PRs are written by an agent and reviewed by
the owner (see [review-rubric.md](review-rubric.md)).

## Run it locally

```bash
gh pr list --repo Danathar/tududi --state all --limit 500 \
  --json number,author,state,createdAt,mergedAt,closedAt,labels,title \
  > prs.json
node scripts/pr-metrics.mjs --input prs.json                 # markdown tables
node scripts/pr-metrics.mjs --input prs.json --format json   # machine-readable
gh pr list ... | node scripts/pr-metrics.mjs                 # stdin also works
```

Options: `--now <ISO time>` (fix the report time so a saved input reproduces
the same output), `--window-days <n>`, `--owner <login>`, `--json-out <file>`
(write JSON in addition to the chosen stdout format). The script does no
network I/O and writes nothing to GitHub. Its tests are
[`scripts/tests/pr-metrics.test.mjs`](../scripts/tests/pr-metrics.test.mjs):
`node --test scripts/tests/pr-metrics.test.mjs`.

`--limit 500` is a ceiling, not a page: if the repository ever has more than
500 PRs the oldest are silently missing, and all-time numbers are wrong.
Raise the limit before that happens.

## Weekly run

[`.github/workflows/pr-metrics.yml`](../.github/workflows/pr-metrics.yml) runs
every Monday (and on demand from the Actions tab), executes the same two
commands, writes the markdown to the run's step summary and uploads
`pr-metrics.md` and `pr-metrics.json` as the `pr-metrics` artifact for 90
days. It has read-only permissions and commits nothing. Runs are listed at
<https://github.com/Danathar/tududi/actions/workflows/pr-metrics.yml>.

## How to read the numbers

- **A 100% acceptance rate is not a quality signal here.** Nearly every PR is
  opened and merged by the same person, so a high rate says who opens PRs, not
  how good they are. It only becomes informative for classes with an
  independent decider: watch the Hive app row. A Hive PR that is closed
  unmerged is the useful event.
- **Time to merge** measures how long the owner took to review, plus CI time.
  Short medians mean small PRs and fast review, not low rigor. Read the p90
  for the slow tail, and read neither without the sample size in the JSON
  (`timeToMergeHours.samples`).
- **Open counts** include draft PRs; a rising
  open count with a flat merged count is the signal to look at.
- Small samples: with fewer than about ten decided PRs in a window, treat
  percentages as anecdotes.

## Not measured

- **Throughput or velocity.** Optimising it would mean rushing review.
- **Review findings per PR.** The Codex connector comments on PRs, but the
  counts depend on how findings are posted (inline comments versus review
  bodies) and are not derived by this script. Severity levels are defined in
  [review-rubric.md](review-rubric.md).
- **Coverage and CI health.** Those are tracked in [quality.md](quality.md).
