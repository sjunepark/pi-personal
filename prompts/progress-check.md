---
description: Explain what is done and left in a progress doc
argument-hint: "<PLAN/TODO/ROADMAP doc or context>"
---

Explain the current status of the relevant progress document: `$ARGUMENTS`

Use this as a read-only progress check. Do not edit files, stage, commit, or push unless explicitly asked after the report.

1. Identify the target progress document from `$ARGUMENTS`.
   - Accept direct paths, mentioned files such as `@PLAN.md`, or contextual descriptions.
   - If the repo has multiple plausible progress docs and the target is unclear, ask which one to review.
2. Read the target doc completely, then inspect only the implementation evidence needed to verify its status:
   - referenced files, modules, tests, routes, commands, or docs
   - relevant git status/diff only when the current working tree may affect the answer
3. Classify items from the progress doc:
   - done: clearly implemented or no longer relevant because the completed work superseded it
   - partially done: meaningful progress exists, but acceptance criteria or follow-through remain
   - left: not implemented, blocked, or still explicitly planned
   - stale/unclear: the doc conflicts with code evidence or lacks enough detail to classify confidently
4. Distinguish doc claims from verified code evidence. Do not mark something done just because the doc says so.
5. Keep the answer concise and useful for deciding what to do next.

Output:

```markdown
## Progress status

One short summary of where this plan stands.

## Done

- ...

## Partially done

- ...

## Left

- ...

## Stale or unclear

- ...

## Recommended next step

The most useful next action, including whether the progress doc should be updated.
```

Omit empty sections except `Recommended next step`. Name the progress doc reviewed.
