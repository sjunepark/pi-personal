---
description: Carefully integrate another branch without blind git merge behavior
argument-hint: "<branch>"
---

Carefully integrate branch `$1` into the current branch.

Operate in strict conservative mode. Do not blindly run `git merge $1`, do not accept append-style or conflict-marker-driven results, and do not infer user intent from incomplete evidence.

Instead:

1. Check the current branch and working tree state.
2. Inspect the branch differences first:
   - commit history
   - file-level diff
   - relevant changed code paths
3. Understand the intent of both branches from evidence, not guesses.
4. Integrate only changes whose intent and destination are clear.
5. Prefer coherent edits/refactors over mechanical merge output.
6. Preserve current-branch behavior unless `$1` clearly and intentionally changes it.
7. Treat any confusing, ambiguous, surprising, inconsistent, or only-slightly-unclear change as blocked on user clarification.
   - Ask before editing that area. Do not assume whether to keep, delete, add, rename, move, refactor, reconcile, or reinterpret unclear content.
   - Ask even when one interpretation seems likely but is not directly supported by the branch history, diff, or existing code structure.
   - Prefer a short clarification question that names the file/path, explains the ambiguity, and offers the plausible choices.
   - Continue only with unrelated safe edits while waiting; do not make provisional or reversible-looking edits in the ambiguous area.
   - Example: if a TODO item that clearly is not implemented exists on one branch but not the other, the user may have intended to delete it or may want it added to the merged TODO list. Ask which interpretation is correct.
   - Treat this as a general rule for similar ambiguity, not only TODO files.
8. Ask before choosing between two plausible behaviors, APIs, data shapes, dependency versions, names, deletions, or test expectations.
9. If clarification is needed, stop with the question before summarizing the merge as complete.
10. Run relevant tests, typecheck, lint, or build commands if available after safe integration work.
11. Summarize:
   - what was integrated
   - files changed
   - merge decisions made
   - clarifications requested or still pending
   - remaining risks

Target branch to integrate: `$1`
