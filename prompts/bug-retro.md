---
description: Analyze a bug or failure for root cause, design smell, and prevention refactors
argument-hint: "[failure, test, file, PR, or context]"
---

Analyze this bug or failure as a concise engineering postmortem, not just a fix summary.

Context to inspect: $ARGUMENTS

If the context is missing or ambiguous, first infer the most likely target from the current conversation, session history, failing test, error output, or referenced files. Ask only if multiple plausible targets would materially change the analysis.

Answer these questions with evidence from the code and observed failure:

1. What caused the failure?
   - State the visible symptom and the expected behavior.
   - Identify the immediate defect that produced the failure.
   - Trace the causal chain far enough to explain why the code allowed it.
   - Distinguish confirmed facts from plausible hypotheses.

2. Was this a simple mistake, or does it reveal bad design / code smell?
   - Classify it as one of:
     - simple local mistake
     - weak validation or invariant gap
     - unclear ownership / boundary problem
     - weak type or schema model
     - state, lifecycle, concurrency, or ordering hazard
     - over-abstraction, under-abstraction, or duplicated logic
     - brittle integration or contract mismatch
   - Explain why the classification fits.
   - Note any design issue that made the bug easy to introduce or hard to detect.

3. What would make this codebase more robust?
   - Focus on code design improvements and refactors that would prevent this class of bug.
   - Separate recommendations into:
     - immediate fix already made or needed
     - small low-risk refactor worth applying now
     - larger refactor or design change worth discussing first
     - narrow regression coverage only if it clarifies or protects the design invariant
   - When proposing design enhancements or refactors that are not obviously local and low-risk, present 2-4 viable options instead of a single preferred path.
   - For each option or refactor, explain:
     - what invariant or boundary it strengthens
     - how it prevents this class of bug
     - pros and concrete benefits
     - cons, tradeoffs, and practical limits
     - risk, effort, and expected payoff
   - Clearly identify the recommended option, but preserve enough comparison detail for the user to choose among alternatives.
   - Prefer making invalid states unrepresentable over adding defensive patches.

4. What should we do next?
   - Give a clear recommendation: keep the local fix, patch further, refactor now, or defer.
   - If a fix or refactor is obvious, low-risk, and within the current task scope, apply the patch instead of only proposing it.
   - If tradeoffs require product, domain, or maintainability judgment, ask for a decision instead of silently changing direction.

Use this output shape:

```markdown
## Cause

## Mistake vs. design signal

## Robustness improvements

| Option | Prevents | Pros | Cons / tradeoffs | Effort | Risk | Recommendation |
| --- | --- | --- | --- | --- | --- | --- |

## Applied patch, if any

## Recommended next step

## Open questions, if any
```

Be direct and specific. Keep the focus on design failure, code smell, ownership, invariants, and refactors. Avoid vague advice like "add more tests" unless you name the exact behavior or invariant the test should protect.
