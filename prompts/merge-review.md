---
description: Audit a completed branch merge for lost intent, unsafe assumptions, and integration quality
argument-hint: "[source branch or merge context]"
---

Review the recent merge result as an integration audit, not as a general code review.

Optional merge context or source branch: `$ARGUMENTS`

Operate conservatively. Do not assume the merge is correct because conflicts are resolved or tests pass. Do not rewrite substantial behavior during the review unless the fix is clearly mechanical and low-risk; otherwise report the issue and ask for a decision.

First establish the merge context from evidence:

1. Identify the current destination branch and working tree state.
2. Determine whether the merge is still uncommitted, staged, or already committed.
3. Identify the source branch or merge parent if possible from `$ARGUMENTS`, `MERGE_HEAD`, `ORIG_HEAD`, merge commits, reflog, or branch history.
4. Compare all relevant views:
   - destination before the merge
   - source branch changes
   - final merge result
   - conflict resolutions or manual edits made during the merge
5. If the merge target, source, or base cannot be determined confidently, stop and ask for clarification before judging intent.
6. Verify merge-shape integrity when the source is known:
   - for an uncommitted merge, confirm `MERGE_HEAD` matches the intended source
   - for a committed merge, confirm the source tip is reachable from `HEAD` or that non-convergent history was explicitly requested
   - flag squash, cherry-pick, copied-patch, or ordinary-commit results when the task intended a real branch merge

Audit for these concerns:

## 1. History and merge-shape integrity

Check that the result is actually the kind of merge the task intended, not only that the working tree looks plausible.

Look for:

- missing merge parents or missing `MERGE_HEAD` during an in-progress merge
- source branch tips that are not reachable from the destination after a completed whole-branch merge
- conflict resolutions made on top of a squash, cherry-pick, or copied patch without explicit permission
- final trees that appear correct locally but would leave future branch convergence, ancestry, or repeated-merge behavior broken

## 2. Lost or partially integrated features

Check that the final result did not accidentally leave out source-branch behavior, tests, docs, configuration, migrations, assets, error handling, or edge cases.

Also check the reverse: destination-branch behavior should still work unless the source branch clearly intended to replace it.

Look for:

- commits whose intent is not represented in the final tree
- conflict resolutions that kept one side and dropped the other without evidence
- deleted files, routes, exports, tests, docs, or TODOs whose removal is not explained by the merge intent
- renamed or moved concepts that left stale references behind
- dependency, config, schema, or migration changes that landed without their callers or consumers
- tests that were removed, weakened, skipped, or made less specific to make the merge pass

## 3. Unsafe assumptions about product or design intent

Flag any place where the merge appears to have decided product behavior, API shape, naming, data model, permissions, defaults, feature flags, user flows, or compatibility policy without clear evidence.

Do not treat a plausible interpretation as permission. If two interpretations are reasonable, ask the user to choose.

## 4. Blind append or side-by-side integration

Look for code that was appended because both branches changed nearby areas, but the result does not form one coherent design.

Examples:

- duplicate helpers, types, config fields, components, routes, commands, or validation paths
- two competing sources of truth
- parallel abstractions that now need one boundary or owner
- compatibility shims, fallbacks, adapters, or dual-read/write paths added without a real rollout need
- ordering, lifecycle, async, caching, or state interactions that changed because both sides now run together
- error handling or logging paths that now conflict, duplicate, or hide failures

## 5. Missed refactor opportunities created by combining branches

Consider whether the best merge is not a literal combination of both diffs.

Recommend a refactor when it would make the merged result clearer, safer, or smaller, especially when both branches touched the same concept. Prefer one coherent path over layered special cases, but do not remove intentional behavior without evidence.

Good refactor candidates include:

- consolidating duplicated logic introduced independently on both branches
- renaming or relocating code so ownership is obvious after the merge
- tightening types, schemas, or invariants exposed by the integration
- replacing branch-specific conditionals with a shared model
- simplifying tests so they specify behavior rather than merge mechanics
- updating docs to describe the merged design instead of both historical approaches

## 6. Cross-file and cross-layer side effects

Trace interactions across boundaries, not only local conflicts.

Check likely affected contracts:

- imports, exports, public APIs, CLI commands, routes, load/action boundaries, hooks, and event handlers
- database schemas, migrations, generated types, fixtures, and seed data
- environment variables, config defaults, feature flags, package scripts, and dependency versions
- auth, permissions, privacy, validation, serialization, and error surfaces
- build, lint, format, typecheck, tests, and generated artifacts
- documentation, examples, changelogs, roadmap/TODO files, and user-facing copy

## 7. Validation quality

Run the repository's relevant existing validation commands when practical. Prefer targeted tests for the merged area plus the broadest cheap safety check available.

If validation cannot be run, explain exactly why and what should be run next.

Output this structure:

```markdown
## Merge-review verdict

Pass | Needs fixes | Blocked on decision

## Merge context

- Destination:
- Source / merge parent:
- Base or pre-merge ref:
- Review scope:

## History and merge-shape issues

## What was preserved

## Possible omissions or regressions

## Questionable assumptions

## Append-only or interaction problems

## Refactor opportunities

## Validation

## Applied low-risk fixes, if any

## Decisions needed, if any

## Recommended next step
```

Be specific. Name files and behaviors. Separate confirmed defects from risks. If the merge is sound, say why rather than only saying it passed.
