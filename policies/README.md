# Policies as code

JSON policies that `node scripts/check-policies.mjs` evaluates against the
repository tree. The `policy-check` workflow
([`.github/workflows/policy-check.yml`](../.github/workflows/policy-check.yml))
runs it on every pull request and push to `main`. Tests are in
[`scripts/tests/check-policies.test.mjs`](../scripts/tests/check-policies.test.mjs)
(`node --test scripts/tests/check-policies.test.mjs`).

This repository is a fork. Pull requests and issues go to `Danathar/tududi`
(`--repo Danathar/tududi`), never to `chrisvel/tududi`. See
[AGENTS.md](../AGENTS.md), section "This repository is a fork. All work happens
here."

Changing a policy is a Tier 1 change in [docs/risk-tiers.md](../docs/risk-tiers.md)
and needs the owner.

## fork-target.json

Stops agent instructions from sending work upstream.

- Every file that exists and matches `directionGlobs` must contain the literal
  `--repo Danathar/tududi` and must mention `AGENTS.md` (except `AGENTS.md`
  itself). Globs for files that do not exist are ignored.
- In those files and in every `.md` under the repository root, `docs/`,
  `.github/`, `.claude/` and `policies/` (`scanGlobs`), each `gh pr|issue|release|workflow|label`
  write command (`create`, `comment`, `edit`, `close`, `reopen`, `merge`,
  `review`, `delete`, `run`) must carry `--repo Danathar/tududi`, `-R Danathar/tududi`,
  or `GH_REPO=Danathar/tududi` on the same logical line. A command continued
  with a trailing backslash is one line. There is no exemption for prose: describe
  an unscoped command in words, or add the flag.
- No scanned line may pass `--repo`/`-R`/`GH_REPO` for `chrisvel/tududi`, make the upstream
  repository the `gh` default, or `git push` to `upstream`. Read-only
  links to upstream are allowed.
- `excludeGlobs` is empty on purpose. The inherited upstream docs
  (`.github/CONTRIBUTING.md`, `docs/NN-*.md`) contain no `gh` write commands,
  so they need no exemption. Add one only if that changes.

## workflow-permissions.json

For every `.github/workflows/*.yml`:

- a top-level `permissions:` block is present, so the token never gets the
  repository default;
- `pull_request_target` is not used;
- every `uses:` outside `actions/` and `github/` is pinned to a 40-character
  commit SHA (keep the tag in a trailing `# vX` comment); local `./` and
  `docker://` references are skipped;
- a workflow that runs a `gh` write command sets `GH_REPO` or passes `--repo`.

## Risk tiers

Not a JSON policy file: the checker also compares the tier table in
[docs/risk-tiers.md](../docs/risk-tiers.md) with
[`risk-config.json`](../risk-config.json) and fails when tier numbers, names,
paths, required commands or review values differ.
`node scripts/check-policies.mjs --classify <path>...` prints the tier of a
path.
