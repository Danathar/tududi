# Sync upstream into the fork (by hand)

Fork rule: this is `Danathar/tududi`. Open the PR with
`gh pr create --repo Danathar/tududi --base main --head <branch>` and never
target `chrisvel/tududi`. Upstream is read-only: fetch from it, never push to
it. See [AGENTS.md](../../AGENTS.md), sections "This repository is a fork. All
work happens here." and "Docker images". Only run this when the owner asks;
do not automate it or add a scheduled sync.

Task: merge upstream release `<version>` into the fork.

1. `git fetch upstream` and `git fetch origin`. Check `git remote -v` shows
   `upstream ... (push) DISABLE`.
2. `git switch -c sync/upstream-<version> origin/main`, then
   `git merge upstream/main` (or the release tag).
3. Resolve conflicts keeping the fork's choices from `AGENTS.md`:
   - licence: keep `LICENSE`, `LICENSE.MIT`, the README attribution and the
     GPL-3.0-only identifiers in `package.json`, `package-lock.json` and
     `backend/config/swagger.js`;
   - workflows: keep `docker-publish.yml` (ghcr.io/danathar/tududi) and do not
     restore upstream's tag-driven release or deploy workflow;
   - docs and links point at `Danathar/tududi`, not `chrisvel/tududi`.
4. The `package.json` version is taken from upstream as-is. Do not bump it or
   add a suffix.
5. Run `npm install`, `npm run lint`, `npm test`, `npm run backend:test:upgrade`,
   `npm run build`.
6. Push the branch to `origin` and open the PR with
   `gh pr create --repo Danathar/tududi --base main --head sync/upstream-<version>`.
   Do not merge it yourself; the owner does.
