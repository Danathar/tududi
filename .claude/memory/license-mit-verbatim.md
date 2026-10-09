# LICENSE.MIT stays verbatim

**Date:** 2026-10-09
**Wrong:** treating `LICENSE.MIT` as leftover, editing it, renaming it, or
"cleaning up" the MIT references when the fork changed to GPL-3.0-only.
**Right:** `LICENSE.MIT` is upstream's MIT licence and the notice "Copyright
2024, 2025 Tududi Developers", kept byte-identical. The fork's own licence is
`LICENSE` (GPL-3.0-only). Keep the attribution in the License section of
`README.md`. Do not change the licence identifiers in `package.json`,
`package-lock.json` (root package entry) or `backend/config/swagger.js` back to
MIT or ISC. Leave the strings in `backend/modules/landing/locales/` that call
the app MIT alone: they belong to upstream's Cloud marketing site, not to this
fork's licence statement.
**Why it matters:** the MIT licence requires its notice to travel with the
upstream code this fork incorporates. Dropping it breaks that condition.
**Evidence:** `LICENSE.MIT` was created in `0a6fd2be` (PR #1, merge
`15792362`) and is byte-identical to the previous `LICENSE` at `0a6fd2be^`
(`git show 0a6fd2be^:LICENSE | cmp - LICENSE.MIT`); [AGENTS.md](../../AGENTS.md)
section "Licensing"; PR #1 body.
