# Make progress-handoff produce concise, useful plan docs

## Summary

Revise `prompts/progress-handoff.md` so generated plan/progress documents are shorter and more actionable. The current template preserves useful context, but it also encourages boilerplate sections, long validation catalogs, exhaustive file maps, stale progress logs, and predictable `Next command` blocks.

The desired output is a compact next-session briefing: current objective, durable decisions, immediate next slice, and only the files, validation, blockers, or commands that materially help the next agent.

## Triggering case

Review of Creo `docs/plans/` showed several handoff-generated plans that are longer than the active implementation state warrants:

- `desktop-browser-agent-tools.md`: 348 lines; validation section is 23 lines.
- `webfetch-tool.md`: 262 lines; implementation plan is 75 lines and likely files/areas is 38 lines.
- `desktop-release-operations.md`: 204 lines; validation section is 37 lines, including long one-off release commands with placeholders.
- `workflow-assistant-session-settings.md` and `workflow-assistant-transport-routing.md`: validation sections include expanded file-specific commands that become stale quickly.
- `sidebar-workflow-assistant.md`: historical validation/progress detail dominated the plan until it was collapsed into current state and one concrete browser-test follow-up.
- Many generated plans include a dedicated `Next command` section containing only `/progress-run <plan>`, which is predictable and low-signal.

The issue is not that these plans are wrong; they preserve too much by default. A fresh session needs the current objective, decisions, immediate next slice, important files, and any real blocker more than a transcript-like outline.

## Problem

The current `progress-handoff` prompt mandates a broad template:

- Goal
- Handoff summary
- Decisions already made
- Scope in/out
- Implementation plan
- Likely files and areas
- Validation
- Risks and edge cases
- Open questions
- Progress notes
- Next command

This creates several failure modes:

1. **Validation bloat**: models list every plausible command, expand `lint:files` with long path lists, or preserve historical validation logs that belong in commits or review reports.
2. **Boilerplate sections**: `Next command`, empty `Progress notes`, generic `Validation`, and vague `Open questions` add repeated lines without improving comprehension.
3. **Duplicate context**: `Handoff summary`, `Decisions`, `Scope`, and `Risks` often repeat the same facts in different shapes.
4. **Overlong task trees**: `Implementation plan` can become an exhaustive mini-spec instead of the next few reviewable slices.
5. **Stale specifics**: exact changed-file validation commands, long path inventories, and old blocker notes age poorly as implementation moves.

## Goals

- Keep handoffs implementation-ready, not transcript-complete.
- Bias generated plans toward a short next-session briefing plus the next reviewable slice.
- Make validation optional and durable: include it only when it adds non-obvious next-session value.
- Replace broad file inventories with a short “inspect first” list, or omit the list when it would be obvious.
- Remove predictable boilerplate such as dedicated `/progress-run <plan>` command sections.
- Preserve important decisions, constraints, rejected alternatives, real blockers, and open questions that affect the next slice.

## Proposed prompt changes

### 1. Replace the mandatory template with a lean default

Suggested core structure:

```markdown
# <Feature / task title>

## Purpose

What we are trying to change and why. Keep this to a short paragraph.

## Current state

- Confirmed decisions and constraints that matter for implementation.
- Relevant completed work or repository evidence, only when needed.
- Open blockers or assumptions, if any.

## Next implementation slice

- [ ] Small, reviewable step 1
- [ ] Small, reviewable step 2
- [ ] Small, reviewable step 3
```

Allow optional sections only when they carry distinct information:

- `## Files to inspect first`: max 3-5 files or areas, each with a reason; omit broad module maps.
- `## Validation`: only non-obvious focused checks, current validation blockers, or manual QA cues.
- `## Open questions`: only questions that block or materially shape the next slice.
- `## Decisions and rejected alternatives`
- `## Risks and edge cases`
- `## Reference notes`
- `## Progress log`

### 2. Add length and density guidance

Add guidance such as:

- Target 80-140 lines for ordinary handoffs.
- Prefer 3-7 bullets per section.
- Prefer one immediate implementation slice over a full project roadmap.
- If a section would be empty, obvious, generic, or low-signal, omit it.
- Prefer latest actionable state over historical logs.
- Put lengthy research/reference material in an optional appendix only when it is needed to avoid re-investigation.

### 3. Make validation optional and concise by default

Update the validation instruction to say:

- Omit `## Validation` entirely when it would only restate repository conventions.
- Include only commands that are known and likely to be useful for the next slice.
- Prefer generic file placeholders over expanded path lists: `bun run lint:files -- <changed-files>`.
- Split validation into at most three categories when needed: fast check, before merge, manual QA.
- Do not list broad `check/test/lint/build` commands unless the repository convention or risk justifies them.
- Do not include long one-off operational commands unless they are the actual next action; link/name the script or describe where to find the command instead.
- Record previous validation results only when they were just run and materially affect the next session.
- Do not keep dated validation history in the plan; collapse it into current state or leave it to commits/review reports.

### 4. Remove the dedicated `Next command` section by default

The final response can still recommend `/progress-run <plan-file>`, but the plan file itself should not need a repeated `Next command` section.

Allow a concrete next command only when it is the real, non-obvious unblocker or immediate action, such as installing a missing browser cache and rerunning focused browser tests. Put that command under `Current state` or `Next implementation slice`, not in a predictable standalone section.

### 5. Reframe and cap progress notes

Instead of creating an empty `Progress notes` section in every handoff, instruct `/progress-run` to add a compact dated `Progress log` only after work occurs. Each entry should include:

- completed slice
- validation result if meaningful
- blocker or next slice

Avoid copying full command output into the plan. Do not let progress logs grow indefinitely; older entries should be collapsed into current state or removed once they no longer help continuation.

## Acceptance criteria

- New handoff plans omit empty sections and do not include a dedicated `Next command` section by default.
- Plans may omit `Validation`, `Files to inspect first`, and `Open questions` when those sections would be generic or low-signal.
- Validation sections stay compact and do not expand long file-specific command lines unless truly necessary.
- Any next command is included only when it is a concrete, non-obvious immediate action or unblocker, not a repeated `/progress-run <plan>` instruction.
- Generated plans prioritize `Current state`, the next reviewable implementation slice, and only the files/checks/questions needed to continue safely.
- Ordinary generated plans are short enough to skim quickly, with a soft target around 80-140 lines.
- Progress logs do not grow indefinitely; older validation/history is collapsed into current state or left to commits/review reports.
- Important decisions, constraints, rejected alternatives, and blockers are still preserved.
- `/progress-run <plan>` remains able to continue from the generated document without needing the original conversation.

## Non-goals

- Do not remove the ability to create longer reference-heavy handoffs when the task genuinely needs them.
- Do not rewrite existing Creo `docs/plans/` files as part of this ticket.
- Do not add a new ticketing system or broad prompt framework.

## Suggested implementation areas

- `prompts/progress-handoff.md`: revise the generated structure and add concise-section guidance.
- `prompts/progress-run.md`: align progress logging with the new compact plan shape.
- Optional manual test: run the revised prompt concept against one long Creo plan topic and compare before/after density.

## Progress log

### 2026-06-16

- Completed: revised `prompts/progress-handoff.md` to use a lean default plan shape, optional sections, compact validation guidance, no default `Next command` section, and bounded progress-history guidance.
- Completed: revised `prompts/progress-run.md` so continuation sessions update current state/checklists first and add compact dated progress logs only when useful.
- Validation: `npm test` passed with 49 tests; Node emitted existing `MODULE_TYPELESS_PACKAGE_JSON` warnings. `git diff --check -- prompts/progress-handoff.md prompts/progress-run.md` passed. A Python trailing-whitespace check passed for the two prompt files and this ticket.
- Current status: implementation is complete with no known blockers.
- Next slice: review the final diff and decide whether to commit.
