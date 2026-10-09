# Never bump the package.json version

**Date:** 2026-10-09
**Wrong:** giving the fork its own version line: bumping `package.json`,
switching it to CalVer, or adding a suffix such as `-fork.1`.
**Right:** leave `version` in `package.json` exactly as the last upstream sync
brought it (`1.7.11` at `a6225863`). It only changes when the owner merges a
new upstream tag by hand. The ghcr image tag already carries a fork-specific
suffix: `:v<package.json version>-<short sha>`.
**Why it matters:** backups embed the app version, and
`checkVersionCompatibility` in `backend/services/backupService.js` refuses to
restore a backup whose version compares greater than the running app's
(`comparison > 0` returns `compatible: false`, "Cannot restore backup from
newer version ..."). A fork-only version number would block restores in one
direction or the other.
**Evidence:** `backend/services/backupService.js:94-105` at `a6225863`;
[AGENTS.md](../../AGENTS.md) section "Docker images" (last paragraph); PR #5
body (last bullet: "keeps upstream's `package.json` version ... a fork-only
version would block restores"); PR #5 removed upstream's `release.yml`, which
cut upstream-style versions.
