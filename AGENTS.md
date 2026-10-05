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
bare `gh pr create` or `gh issue create` targets **`chrisvel/tududi`**, not
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
upstream: `.github/CONTRIBUTING.md`, `.github/FUNDING.yml`, and the External
Resources section of `CLAUDE.md`. Their technical content (tests,
migrations, translations, code style) still applies. Wherever they say to
open an issue, discussion, or pull request upstream, use this fork instead.

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
