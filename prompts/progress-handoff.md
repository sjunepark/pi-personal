---
description: Create a root PLAN-*.md implementation handoff from the current discussion
argument-hint: "[handoff focus or instructions]"
---

Create an implementation handoff document from the current discussion.

Additional user instruction or context passed with this command: `$ARGUMENTS`

This prompt is for ending a long discussion and preparing a fresh implementation session. Do not implement code, stage files, commit, or push.

Use the current conversation as the primary source of truth. If additional command text is present above, treat it as the user's latest explicit instruction for the handoff. If it is empty, proceed from the current conversation alone. Inspect the repository only as needed to make paths, commands, and constraints concrete.

1. Infer the target plan file path.
   - First inspect the repository for an existing plan-file convention. Check for directories such as `plans/`, `docs/plans/`, `.pi/plans/`, or existing files matching `PLAN*.md`, and prefer the convention already used by the repository.
   - If no convention exists, create `PLAN-<UPPERCASE-SLUG>.md` in the repository root, for example `PLAN-CLI.md` or `PLAN-POST-REVIEW-LOOP.md`.
   - Choose a short, specific topic slug from the task or feature discussed.
   - Prefer concrete product/code nouns over vague words like `TASK`, `UPDATE`, or `CHANGES`.
   - If the topic is genuinely ambiguous, ask for a short slug before writing.
   - If the inferred file already exists, read it and ask before overwriting, merging, or substantially rewriting it.

2. Distill the discussion into an implementation-ready handoff.
   - Preserve decisions, constraints, intended behavior, naming choices, and rejected alternatives.
   - Remove discussion noise, resolved uncertainty, and irrelevant context.
   - Clearly separate confirmed decisions from assumptions and open questions.
   - Name files, commands, and constraints only when they come from the discussion or repository evidence; otherwise mark them as areas to identify during implementation.
   - Keep the plan concrete enough that `/progress-run <PLAN file>` can start work in a new session.

3. Write the plan file using this structure:

~~~markdown
# <Feature / task title>

## Goal

What we are trying to implement and why.

## Handoff summary

Concise summary of the discussion so a fresh session can start without reading the old conversation.

## Decisions already made

- ...

## Scope

### In scope

- ...

### Out of scope

- ...

## Implementation plan

- [ ] Step 1
- [ ] Step 2
- [ ] Step 3

## Likely files and areas

- `path/to/file`: why it may matter

## Validation

Run these when relevant. Include only commands known from the repository or discussion; otherwise say no configured validation was identified yet.

```bash
...
```

## Risks and edge cases

- ...

## Open questions

- ...

## Progress notes

Use this section during `/progress-run` to record completed work, blockers, validation, and next steps.

## Next command

```text
/progress-run <this-plan-file-path>
```
~~~

4. After writing the file, report only:
   - created or updated file path
   - recommended next command
   - open questions that should be answered before implementation, if any
