# Review a pull request

Fork rule: this is `Danathar/tududi`. Use `--repo Danathar/tududi` on every
`gh` command (for example `gh pr view <n> --repo Danathar/tududi`) and never
target `chrisvel/tududi`. See [AGENTS.md](../../AGENTS.md), section "This
repository is a fork. All work happens here."

Task: review PR `#<n>`.

1. `gh pr view <n> --repo Danathar/tududi` and
   `gh pr diff <n> --repo Danathar/tududi`. Read the linked issue.
2. Check, in this order:
   - correctness against the issue and the docs in `docs/`;
   - tests cover changed behaviour (`backend/tests/`, frontend tests);
   - migrations are dialect-safe for SQLite and PostgreSQL
     (`docs/database.md`) and the model matches;
   - new UI strings exist in all 25 `public/locales/*/translation.json`;
   - routes use repositories, not models; authorization via `hasAccess`;
   - no licence, version, image-name or upstream-targeting changes forbidden
     by `AGENTS.md`.
3. Confirm CI: `gh pr checks <n> --repo Danathar/tududi`. Both `test-sqlite`
   and `test-postgres` must pass, and the branch must be current with `main`.
4. Report findings with file:line references and severity. Post them with
   `gh pr review <n> --repo Danathar/tududi --comment --body-file <file>` only
   if the owner asked; otherwise return them in chat. Never push to another
   contributor's branch.
