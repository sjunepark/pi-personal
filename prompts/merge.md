---
description: Carefully integrate another branch without blind git merge behavior
argument-hint: "<branch> [dry] [instructions...]"
---

Carefully integrate source branch `$1` into the current destination branch.

Invoke as `/merge <branch> [dry] [instructions...]`. Treat `$1` as the source branch and `${@:2}` as optional flags and user instructions. If `$1` is missing or starts with `-`, stop and ask for the source branch before inspecting or merging.

Requested options and instructions: `${@:2}`. Accept `dry` anywhere in `${@:2}` as a planning-only mode. Treat any remaining text as additional user instructions for this integration, subordinate to the conservative safety rules in this prompt.

Operate in strict conservative mode. Do not blindly run and commit `git merge $1`, do not accept append-style or conflict-marker-driven results, and do not infer user intent from incomplete evidence.

If `dry` is present in the requested options and instructions, analyze the merge without changing repository state:

- Do not run `git merge`, edit files, stage changes, commit, or otherwise mutate the working tree.
- Use read-only git inspection commands to compare destination `HEAD`, source `$1`, and their merge-base.
- Identify likely conflicts, overlapping edits, deleted/renamed files, dependency/config/schema interactions, tests/docs impact, and areas needing user decisions.
- Propose one or more merge strategies with concrete tradeoffs.
- Stop after asking the user how to continue; do not proceed into an actual merge until explicitly instructed.

Convergence is required for real whole-branch integrations. In dry mode, record and report the same anchors, but do not create convergence yet:

- Record the merge anchors before editing or planning: destination `HEAD`, source tip, and merge-base.
- Unless `dry` is requested, default to `git merge --no-commit --no-ff $1` so the final destination commit records `$1` as a merge parent while still letting you inspect, edit, and validate the result before committing.
- If a real merge is started, confirm `MERGE_HEAD` exists and matches the intended source tip. If it does not, stop and resolve the merge-shape problem before editing conflicts.
- Do not integrate by cherry-picking, copying patches, squashing, or creating an ordinary independent commit unless the user explicitly requests that non-convergent history or the source branch should not be recorded as merged.
- Before reporting completion of a real integration, verify `git merge-base --is-ancestor $1 HEAD`. If it fails, the branches have not converged; either convert the work into a real merge or ask the user how to proceed.
- Do not move, force-update, or delete `$1` automatically. In this prompt, convergence means the source branch tip is reachable from the destination `HEAD`; making both branch refs point to the same commit requires explicit user approval.

Instead:

1. Check the current destination branch and working tree state.
2. Inspect the branch differences first:
   - commit history
   - file-level diff
   - relevant changed code paths
3. Understand the intent of both branches from evidence, not guesses.
4. If not in dry mode, use the merge result as a draft for whole-branch integration, then integrate only changes whose intent and destination are clear. In dry mode, use the branch diffs and merge-base analysis to describe likely integration work instead.
5. Prefer coherent edits/refactors over mechanical merge output.
   - When both branches changed the same concept, pause before resolving mechanically. Consider whether the correct merge is a small refactor that creates one coherent owner, model, or execution path.
   - Prefer one clear path over duplicated helpers, parallel abstractions, dual sources of truth, compatibility shims, or side-by-side behavior unless a real rollout or compatibility constraint requires them.
6. Preserve current-branch behavior unless `$1` clearly and intentionally changes it.
7. Treat any confusing, ambiguous, surprising, inconsistent, or only-slightly-unclear change as blocked on user clarification.
   - Ask before editing that area. Do not assume whether to keep, delete, add, rename, move, refactor, reconcile, or reinterpret unclear content.
   - Ask even when one interpretation seems likely but is not directly supported by the branch history, diff, or existing code structure.
   - Prefer a short clarification question that names the file/path, explains the ambiguity, and offers the plausible choices.
   - Continue only with unrelated safe edits while waiting; do not make provisional or reversible-looking edits in the ambiguous area.
   - Example: if a TODO item that clearly is not implemented exists on one branch but not the other, the user may have intended to delete it or may want it added to the merged TODO list. Ask which interpretation is correct.
   - Treat this as a general rule for similar ambiguity, not only TODO files.
8. Ask before choosing between two plausible behaviors, APIs, data shapes, dependency versions, names, deletions, or test expectations.
9. Check cross-layer side effects before finalizing conflict resolutions:
   - imports, exports, public APIs, routes, commands, hooks, and event handlers
   - schemas, migrations, generated types, fixtures, and seed data
   - environment variables, config defaults, feature flags, package scripts, and dependency versions
   - auth, permissions, validation, serialization, privacy, logging, and error surfaces
   - tests, docs, examples, changelogs, TODO/PLAN/ROADMAP files, and user-facing copy
10. Do not delete, skip, loosen, or rewrite tests merely to make the merge pass. Only change tests when the merged behavior intentionally changed and the branch evidence supports that change.
11. If clarification is needed, stop with the question before summarizing the merge as complete.
12. Run relevant tests, typecheck, lint, or build commands if available after safe integration work. In dry mode, do not run expensive or mutating validation; list the checks that should run during the real merge.
13. Before reporting completion, do a short self-review for:
   - source behavior accidentally omitted
   - destination behavior accidentally regressed
   - assumptions about adding, removing, or changing features without evidence
   - append-only integrations that should be unified
   - missed small refactors created by combining both branches
   - validation gaps or unrun relevant checks
14. Summarize:
   - destination branch, source branch, and merge-base
   - requested mode: dry planning or real integration
   - whether a real merge commit was used, or why non-convergent history was explicitly requested
   - convergence verification result, or why it is intentionally not applicable in dry mode
   - what was integrated, or what would be integrated in dry mode
   - files changed, or files likely to change in dry mode
   - merge decisions made
   - clarifications requested or still pending
   - remaining risks
   - in dry mode, recommended next steps and the exact user decision needed before starting the merge

Source branch to integrate: `$1`
Requested options and instructions: `${@:2}`
