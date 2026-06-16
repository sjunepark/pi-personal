---
description: Keep executing a plan file and update progress as you work
argument-hint: "<PLAN file>"
---

Keep executing the plan file: `$ARGUMENTS`

Use this as the working progress tracker. Read it first, then continue with the next clear task in the plan.

- Update the same file as you work so it reflects completed steps, current status, blockers, and next steps.
- Prefer small, safe, validated changes over broad rewrites.
- Keep the plan compact: update `Current state` and the next checklist before appending history.
- Add a compact dated `Progress log` only after actual work occurs and only when it helps continuation. Each entry should include the completed slice, meaningful validation result, blocker if any, and next slice.
- Do not copy full command output into the plan. Summarize the result and keep detailed output in the session, commit, or review report.
- Collapse or remove older progress-log detail once the current state captures what a future session needs.
- If the plan target is unclear, or a step needs a product/design decision, ask before continuing.
- When missing context or requirements block progress, discuss the specific information needed to proceed with the plan and ask focused questions to obtain it.
- Run the relevant existing validation when practical and record important results in the plan file.
- Stop when the plan is complete, blocked, or you need a decision.

Do not stage, commit, or push unless explicitly asked.
