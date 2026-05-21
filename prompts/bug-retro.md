---
description: Analyze a bug or failure for root cause, design smell, and prevention refactors
argument-hint: "[failure, test, file, PR, or context]"
---

Analyze this bug or failure as a concise engineering postmortem, not just a fix summary.

Context to inspect: $ARGUMENTS

If the context is missing or ambiguous, first infer the most likely target from the current conversation, session history, failing test, error output, or referenced files. Ask only if multiple plausible targets would materially change the analysis.

Answer these questions with evidence from the code and observed failure:

1. What caused the failure?
   - Keep this section short and high-level.
   - State the visible symptom, expected behavior, and broad root cause.
   - Explain the causal chain conceptually, not as a detailed code-path trace.
   - Mention exact files, functions, logs, or schemas only when they are essential evidence.
   - Distinguish confirmed facts from plausible hypotheses without over-documenting every step.

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
   - Focus on the best code design improvements and refactors that would prevent this class of bug.
   - Recommend about 3 solutions total. Do not list every possible option.
   - Prefer the strongest practical options: one immediate fix, one small low-risk hardening/refactor, and one larger design direction only if it is genuinely worth discussing.
   - Use prose subsections with headings, not a table.
   - For each recommended solution, explain briefly:
     - what invariant or boundary it strengthens
     - how it prevents this class of bug
     - main benefits
     - main tradeoffs or practical limits
     - effort/risk/payoff in plain language
   - Clearly mark whether each solution is recommended now, deferred, or only worth discussing.
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

### 1. <recommended solution heading>

### 2. <recommended solution heading>

### 3. <recommended solution heading, optional if only two are warranted>

## Applied patch, if any

## Recommended next step

## Open questions, if any
```

Be direct and specific. Keep the focus on design failure, code smell, ownership, invariants, and refactors. Avoid vague advice like "add more tests" unless you name the exact behavior or invariant the test should protect.
