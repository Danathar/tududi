# Task prompts

Reusable prompts for common work in this repository. Paste one into an AI coding
tool (Copilot Chat, Cursor, Claude Code, Codex), or reference the file. Fill in
the `<placeholders>` first.

**Fork rule.** This repository is `Danathar/tududi`, a fork of
`chrisvel/tududi`. PRs and issues go to this fork: pass `--repo Danathar/tududi`
to every `gh` command and never target `chrisvel/tududi`. See
[AGENTS.md](../../AGENTS.md), section "This repository is a fork. All work
happens here."; it wins over any prompt below. Every prompt in this directory
must repeat this rule.

| Prompt | Use it to |
|--------|-----------|
| [add-backend-module.md](add-backend-module.md) | Add a feature module under `backend/modules/` |
| [add-migration.md](add-migration.md) | Add a migration that runs on SQLite and PostgreSQL |
| [add-translation.md](add-translation.md) | Add or change UI strings in all 25 locales |
| [sync-upstream.md](sync-upstream.md) | Bring upstream `chrisvel/tududi` changes into the fork by hand |
| [review-pr.md](review-pr.md) | Review a pull request on this fork |

Other agent files are listed in the "Agent tooling" section of
[AGENTS.md](../../AGENTS.md). Claude Code skills with the same intent live in
`.claude/skills/`.
