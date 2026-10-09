---
name: open-fork-pr
description: Push a branch and open a pull request on Danathar/tududi (the fork), never on upstream chrisvel/tududi. Use whenever a change is ready for review.
---

# Open a PR on the fork

Fork rule: PRs and issues go to this fork. Pass `--repo Danathar/tududi` to
every `gh` command and never target `chrisvel/tududi`. Authoritative rules:
[AGENTS.md](../../../AGENTS.md), section "This repository is a fork. All work
happens here."

1. Confirm the remotes: `git remote -v`. `origin` must be
   `https://github.com/Danathar/tududi.git`; `upstream` push must be `DISABLE`.
2. Work on a branch cut from `origin/main`, for example
   `git switch -c feat/<topic> origin/main`.
3. Run the checks first (skill `run-checks`).
4. Commit with a Conventional Commit message. Do not use `git commit -s`.
5. `git push -u origin <branch>`. Never push to `upstream`.
6. Write the body to a file (not under `/tmp` if the owner forbids it), then:

   ```bash
   gh pr create --repo Danathar/tududi --base main --head <branch> \
     --title "<type>(<scope>): <summary>" --body-file <body.md>
   ```

   The body follows `.github/pull_request_template.md`: what changed and why,
   `Closes #<n>` lines, checks run with real results, and what was not verified.
7. Check that the printed URL starts with `https://github.com/Danathar/tududi/`.
   If it points at `chrisvel/tududi`, stop, close it, and tell the owner.
8. Do not merge the PR; the owner does.
