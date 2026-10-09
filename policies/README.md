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
  `--repo Danathar/tududi`. Globs for files that do not exist are ignored.
- In those files and in every `.md` under the repository root, `docs/`,
  `.github/`, `.claude/` and `policies/` (`scanGlobs`), each `gh pr|issue|release|workflow|label`
  write command (`create`, `comment`, `edit`, `close`, `reopen`, `merge`,
  `review`, `delete`, `run`) must carry `--repo Danathar/tududi`, or `-R Danathar/tududi`
  on the same logical line (an environment variable is not enough in markdown). A command continued
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
  repository default, and it grants no write (`write-all` or `<scope>: write`
  is rejected; grant write on the job that needs it);
- `pull_request_target` is not used;
- every `uses:` outside `actions/` and `github/` is pinned to a 40-character
  commit SHA (keep the tag in a trailing `# vX` comment); local `./` and
  `docker://` references are skipped;
- every logical line that runs a `gh` write command passes `--repo`/`-R` with
  `Danathar/tududi` or `${{ github.repository }}`; or passes `"$GH_REPO"`, or
  nothing, when `env:` of that command's own step, its job or the workflow sets
  `GH_REPO` to one of those values. Scope follows the YAML block, so a
  `GH_REPO` in another job or step does not count. Any other `GH_REPO` or
  `--repo` value (for example the upstream repository) fails;
- a command-local `GH_REPO=<value>` before a `gh` write command (including
  `env GH_REPO=<value> gh ...`) must itself be an allowed value;
- `run:` scripts contain no attacker-controlled expression such as
  `${{ github.event.issue.title }}`, `github.head_ref` or `inputs.*`; pass it
  through `env:` and read `"$VAR"` (see `forbiddenRunExpressions`). Numbers,
  SHAs and `github.event.repository.name` are allowed;
- the write-command list includes `enable`, `disable`, `ready`, `upload`,
  `update-branch`, `lock` and `transfer`, and the `rerun`, `cancel` and `delete`
  verbs of `gh run`, besides
  `create`, `comment`, `edit`, `close`, `reopen`, `merge`, `review`, `delete`, `run`.

## Threat model

The checker catches accidental omissions: an agent-direction file or workflow
that forgets `--repo Danathar/tududi`, a missing `permissions:` block, an
unpinned action, an event expression interpolated into a script. It is not a
shell or YAML parser and does not defend against deliberately obfuscated
commands (variables built at runtime, `eval`, generated scripts, aliases). The
hard boundaries are the repository-scoped `GITHUB_TOKEN` and Hive's proxy; see
[docs/security/SECURITY-AI.md](../docs/security/SECURITY-AI.md).

## Risk tiers

Not a JSON policy file: the checker also compares the tier table in
[docs/risk-tiers.md](../docs/risk-tiers.md) with
[`risk-config.json`](../risk-config.json) and fails when tier numbers, names,
paths, required commands or review values differ.
`node scripts/check-policies.mjs --classify <path>...` prints the tier of a
path.
