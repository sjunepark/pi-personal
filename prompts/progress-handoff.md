---
description: Create a concise implementation handoff plan from the current discussion
argument-hint: "[handoff focus or instructions]"
---

Create a concise implementation handoff document from the current discussion.

Additional user instruction or context passed with this command: `$ARGUMENTS`

This prompt is for ending a long discussion and preparing a fresh implementation session. Do not implement code, stage files, commit, or push.

Use the current conversation as the primary source of truth. If additional command text is present above, treat it as the user's latest explicit instruction for the handoff. If it is empty, proceed from the current conversation alone. Inspect the repository only as needed to make paths, commands, and constraints concrete; do not turn the handoff into a fresh audit.

1. Infer the target plan file path.
   - First inspect the repository for an existing plan-file convention. Check for directories such as `plans/`, `docs/plans/`, `.pi/plans/`, or existing files matching `PLAN*.md`, and prefer the convention already used by the repository.
   - If no convention exists, create `PLAN-<UPPERCASE-SLUG>.md` in the repository root, for example `PLAN-CLI.md` or `PLAN-POST-REVIEW-LOOP.md`.
   - Choose a short, specific topic slug from the task or feature discussed.
   - Prefer concrete product/code nouns over vague words like `TASK`, `UPDATE`, or `CHANGES`.
   - If the topic is genuinely ambiguous, ask for a short slug before writing.
   - If the inferred file already exists, read it and ask before overwriting, merging, or substantially rewriting it.

2. Distill the discussion into an implementation-ready briefing.
   - Preserve durable decisions, constraints, intended behavior, naming choices, rejected alternatives, real blockers, and open questions that affect implementation.
   - Prefer the latest actionable state over historical logs, transcript-like discussion, resolved uncertainty, or duplicate context.
   - Clearly separate confirmed decisions from assumptions and open questions.
   - Name files, commands, and constraints only when they come from the discussion or repository evidence; otherwise mark them as areas to identify during implementation.
   - Keep the plan concrete enough that `/progress-run <PLAN file>` can start work in a new session without reading the old conversation.
   - Target 80-140 lines for ordinary handoffs. Allow longer plans only when the task genuinely needs reference-heavy detail.
   - Prefer 3-7 bullets per section. Omit sections that would be empty, obvious, generic, or repetitive.

3. Write the plan file with this lean default structure:

~~~markdown
# <Feature / task title>

## Purpose

Short paragraph explaining what we are trying to change and why.

## Current state

- Confirmed decisions and constraints that matter for implementation.
- Relevant completed work or repository evidence, only when needed.
- Open blockers or assumptions, if any.

## Next implementation slice

- [ ] Small, reviewable step 1
- [ ] Small, reviewable step 2
- [ ] Small, reviewable step 3
~~~

Add optional sections only when they carry distinct next-session value:

- `## Files to inspect first`: max 3-5 files or areas, each with a reason; omit broad module maps.
- `## Validation`: only non-obvious focused checks, current validation blockers, or manual QA cues.
- `## Open questions`: only questions that block or materially shape the next slice.
- `## Scope`: only non-obvious in/out boundaries that materially constrain implementation.
- `## Decisions and rejected alternatives`
- `## Risks and edge cases`
- `## Reference notes`
- `## Progress log`: only if carrying forward actual completed work, blockers, or just-run validation from the current discussion.

Do not include a dedicated `Next command` section by default. The final response can recommend `/progress-run <plan-file>`, but the plan file itself should not repeat that predictable command. Include a concrete next command in the plan only when it is the real, non-obvious immediate action or unblocker, and place it under `Current state` or `Next implementation slice`.

4. Keep validation concise and durable.
   - Omit `## Validation` entirely when it would only restate repository conventions, list obvious broad checks, or say that no configured validation was identified.
   - Include only commands known from the repository or discussion and likely to be useful for the next slice.
   - Prefer generic placeholders over expanded path lists, such as `bun run lint:files -- <changed-files>`.
   - Use at most three categories when needed: fast check, before merge, and manual QA.
   - Do not list broad `check`, `test`, `lint`, or `build` commands unless repository convention or task risk makes them specifically useful.
   - Do not include long one-off operational commands unless they are the actual next action; name the script or where to find the command instead.
   - Record previous validation results only when they were just run and materially affect the next session.
   - Do not keep dated validation history in the plan; collapse it into current state or leave it to commits and review reports.

5. Keep progress history compact.
   - Do not create an empty progress section.
   - If progress from the current discussion must be preserved, use compact dated `Progress log` entries with only: completed slice, meaningful validation result, blocker, and next slice.
   - Avoid copying full command output into the plan.
   - Collapse or remove older progress entries once `Current state` captures what the next session needs.

6. After writing the file, report only:
   - created or updated file path
   - recommended next command
   - open questions that should be answered before implementation, if any
