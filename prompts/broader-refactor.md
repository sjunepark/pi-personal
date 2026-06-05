---
description: Assess whether an applied issue or proposed fix points to a worthwhile broader refactor
argument-hint: "[applied issue, bug fix, review finding, diff, PR, file, or context]"
---

Pressure-test whether this target should remain a local fix or reveals a broader refactor opportunity that would make the code design clearer, higher-quality, and still appropriately simple.

Target to inspect: `$ARGUMENTS`

If the target is missing or ambiguous, infer it from the current conversation, recent edits, review findings, failing tests, or referenced files. Ask only if multiple plausible targets would materially change the recommendation.

Review the applied issue or proposed fix in context. Focus on the design signal behind it, not just the local patch.

Start with the assumption that the local fix may be sufficient. Recommend a broader refactor only when there is concrete evidence that it would make the design simpler, clearer, safer, or easier to maintain.

Answer these questions:

1. What issue or fix is the refactor related to?
   - Summarize the applied issue, proposed fix, or review finding in one short paragraph.
   - Name the relevant files, functions, components, schemas, or tests when they are useful evidence.
   - Separate confirmed facts from assumptions.

2. Does it reveal a broader design weakness?
   - Classify the main signal as one of:
     - simple local mistake
     - weak validation or invariant gap
     - unclear ownership / boundary problem
     - weak type or schema model
     - state, lifecycle, concurrency, or ordering hazard
     - over-abstraction, under-abstraction, or duplicated logic
     - brittle integration or contract mismatch
   - Explain why the signal fits.
   - If the issue is only a simple local mistake, say so and avoid inventing a refactor.

3. Should this stay local, or is a broader refactor justified?
   - Prefer one best recommendation. Include a second only if it is clearly distinct and worth considering now.
   - Recommend a refactor only when it improves clarity, ownership, invariants, or maintainability enough to justify the change.
   - A good recommendation may be to delete, inline, collapse, rename, move ownership, or tighten a type/schema.
   - Do not equate "broader refactor" with adding a helper, abstraction, service, interface, adapter, framework, compatibility layer, speculative extension point, or broad rewrite.
   - Prefer making the current design simpler and more explicit over adding indirection.
   - If no broader refactor is justified, say "No broader refactor recommended" and explain why.

For each recommendation, explain:

- What design boundary, invariant, or ownership concern it improves.
- What code would move, collapse, rename, tighten, inline, or delete.
- What gets simpler.
- Why this is better than keeping the current local fix only.
- Why it is not over-abstraction.
- Expected benefit, risk, and effort.
- Suggested validation or tests.
- Whether it should be done now, deferred, or left for a decision.

Do not apply code changes unless the user explicitly asks you to implement the refactor. If a tiny mechanical cleanup is obviously safe and directly in scope, mention it separately as an optional applied cleanup only after confirming the current task allows edits.

Use this output shape:

```markdown
## Related issue or fix

## Design signal

## Refactor recommendation

Recommended now | Defer | Decision needed | No broader refactor recommended

### Recommendation

### Why this is not over-abstraction

### Scope and affected files

### Benefit, risk, and effort

### Validation

## Alternative considered, if any

## Recommended next step
```

Be concise, concrete, and skeptical. The goal is design triage: a clearer design, not more architecture.
