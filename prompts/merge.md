---
description: Carefully integrate another branch without blind git merge behavior
argument-hint: "<branch>"
---

Carefully integrate branch `$1` into the current branch.

Do not blindly run `git merge $1` and accept append-style or conflict-marker-driven results.

Instead:

1. Check the current branch and working tree state.
2. Inspect the branch differences first:
   - commit history
   - file-level diff
   - relevant changed code paths
3. Understand the intent of both branches.
4. Integrate the changes deliberately into the current code structure.
5. Prefer coherent edits/refactors over mechanical merge output.
6. Preserve current-branch behavior unless `$1` intentionally changes it.
7. Ask before choosing between two plausible behaviors.
8. Run relevant tests, typecheck, lint, or build commands if available.
9. Summarize:
   - what was integrated
   - files changed
   - merge decisions made
   - remaining risks

Target branch to integrate: `$1`
