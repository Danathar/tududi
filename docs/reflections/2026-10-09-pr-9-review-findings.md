# Review found gaps in PR #9 that its own browser run missed

**Date:** 2026-10-09
**Context:** PR #9 (`809b8f37`, fix `b6aba6fb`, merged as `a777f8f6`), issue #7:
drag a task from All Tasks onto a sidebar area. Codex review of the PR on
`809b8f3`.

## What happened

- The PR body lists 14 browser checks run with real mouse events. Check 14
  covers the Project page, Today, Upcoming, `/inbox`, `/tasks?type=inbox` and a
  Home area page: none of them may accept an area drop. The Completed filter
  and "Assigned to me" are not in that list.
- The Codex review (inline comment on `frontend/components/Tasks.tsx:90`,
  severity P2) pointed out exactly that gap. The page enables drops when the
  path is `/tasks`, there is no `type` or `project_id`, and `status !== 'done'`.
  The Completed filter sets `status=completed`, and "Assigned to me" is
  `/tasks?assigned_to=me&status=active` (`frontend/components/Sidebar/SidebarNav.tsx:87`),
  so both look like All Tasks to the predicate. The reviewer's concern was that
  a reorder attempt there could reassign a completed or assigned task.
- The only commit added after that review, `b6aba6fb`, touches
  `frontend/components/Shared/areaDrop.ts` only. It fixes a different bug,
  described in the PR body's "Review fix" section: the hovered area was only
  recomputed on `mousemove`, so wheel-scrolling the sidebar's area list under a
  still pointer left the highlight, and the drop, on the old row. The author
  reproduced it on `809b8f3` (task landed in `Extra 1` instead of the row under
  the pointer), fixed it, and reran the same steps on `b6aba6f` (task landed in
  `Extra 12`).
- On `a6225863`, `Tasks.tsx:85-90` still reads `status !== 'done'`. I did not
  reproduce the reviewer's scenario. Whether it is a real problem is open; it is
  listed in [.claude/session-summary.md](../../.claude/session-summary.md).

## What it shows

- The scroll bug and the view-scoping gap are the same kind of miss: both live
  in states the author's test matrix did not reach (a still pointer while the
  list moves; filters that reuse `/tasks`). A checklist written from memory
  tests what the author already thought of.
- The scroll fix was done well in one respect: it was reproduced before the
  change and re-run after it, on named commits, so the claim "fixed" is
  something a reader can check.
- A guard that tests for "not X" (`status !== 'done'`) breaks when another
  state is added or already exists; the sidebar defines several `/tasks` views.

## What to do next time

- Build the matrix for a view-scoped feature from the source of truth for the
  views (the entries in `SidebarNav.tsx`, and the `status`/`type`/`assigned_to`
  query markers they set), not from memory.
- Prefer an allow-list predicate (exactly the query that means "All Tasks") over
  excluding states one at a time.
- For an interaction bug, write the before and after run against named
  commits, as `b6aba6f` did.
- Answer every review comment in the PR or in a commit, including the ones you
  decide not to act on; PR #10 did this for its Codex findings, and PR #9's
  predicate comment has no recorded answer in the data I could read.
