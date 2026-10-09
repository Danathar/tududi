# Check reachability before patching upstream hosted-mode (Cloud) code

**Date:** 2026-10-09
**Wrong:** either extreme: patching every automated-review finding in
upstream's hosted tududi Cloud code (trial, billing, landing site,
verification reminders) without asking whether it matters here, or leaving a
real defect alone because the owner's own instance does not enable hosted mode.
**Right:** hosted mode is a supported configuration of this codebase
(`TUDUDI_HOSTED_MODE=true`, [docs/17-hosted-mode.md](../../docs/17-hosted-mode.md)),
so reachability depends on settings, not on the owner's instance. For each
finding, name the gate that guards the code (for example
`hosted.enabled` and `requireSubscription` at
`backend/services/entitlementsService.js:32`, `hosted.enabled` at
`backend/modules/landing/routes.js:180`, `TUDUDI_LANDING_HOSTS` for the
landing site), say whether the gate is open in a supported configuration, and
write the decision in the PR. Fork-only patches to upstream code add conflicts
at every sync (PR #10 merges whole tags with `git merge --no-ff`), so weigh
that cost; the owner decides when the code is reachable in a supported
configuration. This entry does not forbid touching hosted code. Separately,
AGENTS.md (section "Licensing") says to leave the `backend/modules/landing/locales/`
strings that call the app MIT alone unless the owner asks.
**Why it matters:** an unexamined patch costs merge conflicts for no benefit;
an unexamined dismissal can leave a defect in a supported deployment.
**Evidence:** PR #10 body, "Codex review (resolved, no code change)": a P1 on
the 30-day trial-retention text in `terms.ejs` / `privacy.ejs` and a P2 on the
verification reminder marking itself sent before delivery were judged valid in
upstream, left unpatched, and justified by hosted mode not being enabled on
this instance (the owner's decision there; it does not generalise).
