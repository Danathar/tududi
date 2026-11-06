---
name: run-checks
description: Run the repository's lint, backend tests, frontend tests and build before opening a PR, and tell pre-existing failures from new ones.
---

# Run the checks

Fork rule: PRs and issues go to this fork. Pass `--repo Danathar/tududi` to
every `gh` command and never target `chrisvel/tududi`. See
[AGENTS.md](../../../AGENTS.md), section "This repository is a fork. All work
happens here."

Run from the repository root. CI (`.github/workflows/ci.yml`) runs the same
commands in the jobs `test-sqlite` and `test-postgres`.

```bash
npm run lint                  # frontend + backend ESLint
npm run format                # Prettier check (format:fix to write)
npm test                      # backend Jest, needs PostgreSQL (below)
npm run frontend:test         # frontend Jest
npm run build                 # tsc --noEmit + Webpack
```

Backend tests need a PostgreSQL server; start one with
`docker compose -f docker-compose.dev.yml up -d db`. Playwright
(`npm run test:ui`) is optional.

Known frontend failures: when PR #9 was prepared, `npm run frontend:test` failed
`MermaidDiagram`, `MarkdownRenderer.publicLinks` and `roleLabels` on a clean
`main`. Do not assume they still do: stash your change (or check out
`origin/main`), run the failing suite, and only then call it pre-existing. Report
failures you did not cause by name, never as passing.
