# AGENTS.md

Rules for every AI coding agent working in this repository: Claude Code, Codex,
Copilot, Cursor, Gemini, and any other LLM-driven tool. Read this before doing
anything else. Where another file in this repository disagrees with it, this
file wins.

For the codebase guide - commands, architecture, conventions - see
[CLAUDE.md](CLAUDE.md).

## This repository is a fork. All work happens here.

This is **`Danathar/tududi`**, a fork of
[`chrisvel/tududi`](https://github.com/chrisvel/tududi) ("upstream"). Nothing
done here goes upstream. Unless the repository owner (Danathar) explicitly asks
for a specific upstream action, never:

- open a pull request against `chrisvel/tududi`;
- open, comment on, react to, or label an issue, pull request, or discussion
  on `chrisvel/tududi`;
- push to the `upstream` remote, or to any repository other than
  `Danathar/tududi`;
- post in upstream's Discord, Reddit, or other community channels.

Reading upstream is fine: browsing its code, issues, and history, or running
`git fetch upstream` to pick up its changes.

### The `gh` default-repository trap

GitHub CLI treats a fork's parent as the default target. In a fresh clone, a
bare `gh pr` or `gh issue` creation command targets **`chrisvel/tududi`**, not
this fork. So:

- Always pass `--repo Danathar/tududi` to every `gh pr`, `gh issue`,
  `gh release`, and `gh workflow` command, or run
  `gh repo set-default Danathar/tududi` once in the clone and confirm it with
  `gh repo set-default --view`.
- For pull requests, also pass `--base main` and `--head <branch>`.
- Check that every URL `gh` prints starts with
  `https://github.com/Danathar/tududi/`. If one points at `chrisvel/tududi`,
  stop, close what was created, and tell the owner.

### Git remotes

Push only to `origin` (`https://github.com/Danathar/tududi`). If an `upstream`
remote exists, use it for fetching only. To make an accidental push fail, run
`git remote set-url --push upstream DISABLE`.

### Upstream instructions that do not apply

Some files are inherited from upstream and still send contributors to
upstream: `.github/CONTRIBUTING.md` and the External Resources section of
`CLAUDE.md`. Their technical content (tests,
migrations, translations, code style) still applies. Wherever they say to
open an issue, discussion, or pull request upstream, use this fork instead.

### Docker images

This fork's image is `ghcr.io/danathar/tududi`. `.github/workflows/docker-publish.yml`
publishes `:latest`, `:sha-<short commit>` and `:v<version>-<short commit>` on
every push to `main`, and only from `main`. Do not point builds, compose files,
or docs at `chrisvel/tududi` or Docker Hub, and do not reintroduce upstream's
tag-driven release or deploy workflow. Upstream syncs are run by the hive: its
upstream watch files an issue for each upstream release, the scanner opens the
sync PR following `.github/prompts/sync-upstream.prompt.md`, and the hive's
serialized merge lane lands it as a real merge commit, never a squash, so
upstream's history stays in `main`. The owner can still sync by hand. Do not
add a scheduled sync in this repository (no workflow, no cron).

The fork has no version line of its own. `package.json` keeps upstream's
version, which arrives with each upstream sync. Do not bump it, switch it to
CalVer, or add a suffix. Backups embed that version, and
`backend/services/backupService.js` refuses to restore a backup that claims to
be newer than the running app. A fork-only version would block restores in one
direction or the other.

Instead, the build is identified by its commit. `docker-publish.yml` passes
`TUDUDI_BUILD_COMMIT` and `TUDUDI_BUILD_DATE` (the commit date, so both
platforms agree) as build args, the image exposes them as env,
`GET /api/version` returns them as `build` (`backend/services/buildInfo.js`),
and the About page and sidebar footer show `build.tag`, which equals the
image's `:v<version>-<short commit>` tag. `build` is `null` outside such an
image.

## Agent tooling

These files steer AI tools in this repository. All of them inherit the fork
rule above: PRs and issues go to this fork, every `gh pr`, `gh issue`,
`gh release` and `gh workflow` command takes `--repo Danathar/tududi`, and nothing targets `chrisvel/tududi`. Any file added
later that directs an agent must state that rule too.

- `.github/copilot-instructions.md`: GitHub Copilot guide.
- `.cursor/rules/tududi.mdc`: Cursor rule (always applied).
- `.github/prompts/`: task prompts and their catalog (`README.md`).
- `.claude/skills/`: Claude Code skills (`open-fork-pr`, `add-migration`,
  `run-checks`).
- `.claude/settings.json`: Claude Code settings with the Bash guard hook.
- `policies/`: machine-readable agent policies.
- `docs/risk-tiers.md`: how risky a change is and who must review it.
- `docs/security/SECURITY-AI.md`: security rules for AI-assisted changes.
- `.editorconfig`: whitespace settings every editor and agent should honour.
- `.claude/session-summary.md`, `.claude/memory/README.md`, `docs/reflections/README.md`:
  at session start read `.claude/session-summary.md`, and rewrite it at session
  end. Corrections go in `.claude/memory/`, reflections in `docs/reflections/`
  (added by a separate pull request).

## Findings about the Bash guard hook: what is in scope

The Bash guard hook, `.claude/hooks/guard-bash.mjs` (with the shell reader it
imports, `.claude/hooks/shell-reader.mjs`), refuses `gh` writes that do not
target `Danathar/tududi`, force, mirror and delete pushes, and options or
variables that would turn the auto-approved `node`, `npm` and `git` commands
into running code or writing files. It catches **mistakes by an agent that is
following these rules**. It is not a sandbox against an agent that is trying
to get around it. A shell can spell a command in endless ways, and a reader in
a hook cannot keep up with all of them. Do not file, and do not fix
unprompted, findings of this kind:

- **Disguised spellings.** A blocked command gets through only when its name
  or arguments are written in a form nobody types in ordinary work: quote
  marks inside a word (`g"i"t`), brace, wildcard or extended-glob names
  (`{git,}`, `g?t`, `g@(i)t`), backslash-newline splits, `$'...'` escapes,
  variables or command substitution that build the name, or the same tricks
  inside a command string handed to another shell or wrapper program.

These are still in scope. File them as usual:

- **The hook fails open.** It crashes, times out, or is missing a tool, and
  the command runs unchecked.
- **An ordinary spelling gets through.** The command is written the way an
  agent would type it doing normal work: the plain name, its full path
  (`/usr/bin/git`), a documented short option or alias (`git push -f`), or a
  common wrapper used for a real reason (`env`, `timeout`, `xargs`).
- **A regression.** A case the hook's tests already cover stops being
  refused.
- **The hook blocks normal work it should allow.**

This is a standing ruling, not a gap to report: an agent that has to disguise
a command to run it is already breaking the rules in this file.

## Licensing

This fork is licensed **GPL-3.0-only** ([LICENSE](LICENSE)). It incorporates
upstream code released under the MIT License, Copyright 2024, 2025 Tududi
Developers. The MIT licence requires its notice to travel with that code.

- Never delete, edit, or rename `LICENSE.MIT`. It is the upstream MIT licence
  and copyright notice, kept verbatim.
- Keep the attribution in the License section of `README.md`.
- Do not change the licence identifiers in `package.json`, `package-lock.json`
  (root package entry), or `backend/config/swagger.js` back to MIT or ISC.
- Do not add licence headers that describe this fork's own changes as MIT.
- Code copied in from elsewhere must carry a GPL-3.0-compatible licence, and
  its notice must be preserved.

The strings in `backend/modules/landing/locales/` that call the app MIT belong
to upstream's tududi Cloud marketing site. That site is only served when
landing hosts are configured. Those strings are not this fork's licence
statement; leave them alone unless the owner asks.
