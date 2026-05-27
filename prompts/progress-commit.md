---
description: Update stale progress docs, then commit
argument-hint: "[task or commit context]"
---

Update only the progress documentation relevant to the completed work, then commit.

Context: `$ARGUMENTS`

1. Inspect the current git state first:
   - `git status --short`
   - unstaged and staged diffs
   - current branch
2. Identify only the planning documents relevant to this task. Repositories may have multiple `PLAN.md`, `TODO.md`, `ROADMAP.md`, task-plan, or feature-plan files; update the one(s) tied to the changed area, not every progress doc in the repo.
   - Check root-level docs and docs colocated with the changed files or feature.
   - If no relevant planning doc exists, do not create one just for this command.
   - If several are plausible and the right one is unclear, ask before editing.
3. Update stale planning or to-do info only where it is directly supported by the completed work:
   - remove or mark completed items that are actually done
   - adjust next steps that changed because of the implementation or review
   - remove obsolete notes instead of leaving stale checkboxes
   - keep future work that remains true
   - do not rewrite broad roadmap direction unless the diff clearly justifies it
4. Review the final diff, including the plan/TODO updates, for accidental unrelated edits.
5. Run the repository's relevant cheap validation command if it is configured and appropriate. If validation was already run in this session and still applies, mention that instead of rerunning expensive checks.
6. Commit the completed work:
   - stage only the intended task files and the relevant planning-doc updates
   - write a clear normal project commit message; do not mention this prompt template
   - include validation results in the commit body when useful
7. Report:
   - commit hash and subject
   - planning docs updated, or that none were relevant
   - validation run or why skipped
   - any remaining uncommitted changes and why they were left out

Do not delete, reset, restore, or clean unrelated files. If the working tree contains unrelated user changes that cannot be separated safely, ask before committing.
