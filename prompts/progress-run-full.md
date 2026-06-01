---
description: Execute an entire plan file end-to-end with progress updates and WIP commits
argument-hint: "<PLAN file>"
---

Keep executing the plan file until the whole plan is finished: `$ARGUMENTS`

Use the plan file as the authoritative working progress tracker. Read it first, then continue through the next clear tasks without stopping after a single step.

Operating mode:

- If no plan file is provided, or the target is ambiguous, ask for the exact plan file before making changes.
- Before editing, inspect `git status --short` and relevant diffs so unrelated existing work is not mixed into this run.
- Keep progressing until the plan is complete, blocked by a real external issue, or a product/design decision is required.
- Update the same plan file as you work so it reflects completed steps, current status, blockers, validation results, commits made, and next steps.
- Prefer small, safe, validated changes over broad rewrites.
- Run the relevant existing validation after meaningful chunks when practical, and record important results in the plan file.
- If the plan target is unclear, or a step needs a product/design decision, ask before continuing.

Commit mode:

- You may create WIP commits as needed to preserve progress during a long run.
- Before committing, inspect `git status --short` and relevant diffs.
- Stage only intentional changes for the current plan chunk, including the plan-file progress update.
- Do not stage unrelated user changes. If unrelated changes cannot be separated safely, ask before committing.
- Use clear normal project commit messages. `WIP:` is acceptable for incomplete intermediate checkpoints; use a non-WIP final commit message when the committed chunk is complete.
- Do not push unless explicitly asked.

Before stopping, make the plan file accurately state whether the whole plan is complete, what validation was run, which commits were created, and any remaining blockers or follow-up work.
