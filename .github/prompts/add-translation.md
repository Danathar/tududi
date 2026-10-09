# Add or change translations

Fork rule: this is `Danathar/tududi`. Open the PR with
`gh pr create --repo Danathar/tududi --base main --head <branch>` and never
target `chrisvel/tududi`. See [AGENTS.md](../../AGENTS.md), section "This
repository is a fork. All work happens here."

Task: add the UI strings `<keys>` for `<feature>`.

1. Add the keys to `public/locales/en/translation.json` (source of truth).
2. Use them with `t('<key>')` from `useTranslation()` in the component.
3. Add every key to the `translation.json` in each folder under
   `public/locales/` (25 languages). Translate it, or copy the English text.
   No locale may lack the key. There is no sync script; ignore the reference to
   `npm run translations:sync` in `.github/CONTRIBUTING.md`, it is not in
   `package.json`.
4. Keep JSON valid and keep each file's existing key order and indentation.
5. Run `npm run frontend:test` and `npm run lint`. Known failures on a clean
   `main`: `MermaidDiagram`, `MarkdownRenderer.publicLinks`, `roleLabels`.
6. Commit, push to `origin`, open the PR with the `gh` command above and check
   the URL starts with `https://github.com/Danathar/tududi/`.
