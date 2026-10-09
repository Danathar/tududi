# Do not patch upstream's hosted-mode (Cloud) code

**Date:** 2026-10-09
**Wrong:** acting on an automated-review finding in code that only runs for
upstream's hosted tududi Cloud (trial, billing, landing site, verification
reminders) by patching it in the fork.
**Right:** first check whether the code can run here. The hosted-only paths are
gated on `hosted.enabled` and related settings (for example
`backend/services/entitlementsService.js:32`, `backend/modules/landing/routes.js:180`),
and the landing site is only served when `TUDUDI_LANDING_HOSTS` is set. If it
cannot run on this instance, record the finding and the reason in the PR and
leave the code alone.
**Why it matters:** a fork-only patch to code that never runs here buys
nothing and conflicts on every future upstream sync (`git merge --no-ff` of the
whole tag, as in PR #10).
**Evidence:** PR #10 body, "Codex review (resolved, no code change)": a P1 on
the 30-day trial-retention text in `terms.ejs` / `privacy.ejs` and a P2 on the
verification reminder marking itself sent before delivery were both judged
valid in upstream but inert here, and left unpatched.
