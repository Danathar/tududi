# Published metrics

Dated, committed readings of the PR metrics defined in
[`docs/metrics.md`](../metrics.md). The repository is public, so these files
are the public record of how the fork's pull-request flow is going. Each file
is left as it was read; for current values rerun the script or open the latest
`pr-metrics` artifact of the
[weekly workflow](https://github.com/Danathar/tududi/actions/workflows/pr-metrics.yml).

| date | file |
|---|---|
| 2026-10-09 | [snapshot](2026-10-09.md), input [`2026-10-09.prs.json`](2026-10-09.prs.json) |

## Adding a snapshot

Snapshots are made by hand, not by the workflow (Actions never commits here).
This repository is a fork, so the `gh` call names `--repo Danathar/tududi`;
without it, a clone that has the parent as a remote reads `chrisvel/tududi`.
See [AGENTS.md](../../AGENTS.md), section "This repository is a fork. All work
happens here."

```bash
DATE=$(date -u +%F)
NOW=$(date -u +%FT%TZ)
gh pr list --repo Danathar/tududi --state all --limit 500 \
  --json number,author,state,createdAt,mergedAt,closedAt,labels,title \
  > docs/metrics/$DATE.prs.json
node scripts/pr-metrics.mjs --input docs/metrics/$DATE.prs.json --now "$NOW"
```

Put the output in `docs/metrics/$DATE.md` under a header that states the exact
commands, the `--now` value and the `main` commit at the time. Commit the input
JSON beside it so the numbers can be reproduced with
`node scripts/pr-metrics.mjs --input docs/metrics/<date>.prs.json --now <the same time>`.
