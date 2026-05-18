# PLAN.md

## Goal

Implement `post-review-loop` as a **single Pi extension package** that owns the post-implementation review loop end to end.

The current `post-implementation-review-loop` skill is the prototype/spec. The extension should become the source of truth for:

- commands and UI
- loop state
- deterministic phase transitions
- checkpoint compaction and continuation
- ledger persistence
- final report rendering
- model-facing phase prompts and schemas
- guarded git baseline / after-review commit policy

The model still performs the code review and code edits. The extension controls the workflow around that judgment.

## Product shape

Create a new extension under:

```text
extensions/post-review-loop/
```

Suggested files:

```text
extensions/post-review-loop/
├── index.ts          # extension entrypoint, commands, tools, event wiring
├── types.ts          # phase, ledger, finding, validation, report types
├── state.ts          # runtime state restore/persist helpers
├── prompts.ts        # model prompts for each phase
├── gate.ts           # deterministic phase transition logic
├── report.ts         # deterministic final report renderer
├── git.ts            # baseline / after-review commit helpers
├── compact.ts        # checkpoint compaction helpers
└── README.md         # command usage and workflow notes
```

## Core principle

Do not maintain both a large skill and an extension as permanent sources of truth.

After this extension is implemented, the existing skill should either be removed from normal use or reduced to a short compatibility note that points users to the extension commands.

## Responsibilities

### Extension owns

- active loop lifecycle: inactive, active, paused, checkpointing, complete, failed
- current phase: `post-review`, `impl-review`, `impl`, `final-report`
- current iteration and iteration limit
- review scope
- before-review baseline commit state
- after-review commit state
- cumulative ledger
- deterministic stop/continue decisions
- command surface
- status display
- compaction continuation
- final report shape
- validation of model-submitted structured phase results

### Model owns

- reading the real code and diff
- identifying review findings
- classifying findings as Bucket I, Bucket II, rejected, or kept as-is
- verifying findings against real code paths
- implementing accepted Bucket I fixes
- running appropriate repository validation commands
- reporting evidence back through extension tools

## Commands

Register these slash commands:

```text
/post-review-loop start [scope]
/post-review-loop status
/post-review-loop pause
/post-review-loop resume
/post-review-loop stop
/post-review-loop report
```

Optional aliases if they feel better after use:

```text
/pr-loop start [scope]
/pr-loop status
/pr-loop resume
```

### `/post-review-loop start [scope]`

Starts a loop for the current repository state.

Behavior:

1. Refuse to start if another loop is active unless the user confirms replacement.
2. Establish the review scope from args, current diff, or an interactive prompt.
3. Establish the before-review baseline.
4. Persist loop state.
5. Send the first model prompt for `post-review`.

### `/post-review-loop status`

Shows:

- lifecycle status
- current phase
- iteration count and limit
- scope
- baseline commit mode/ref
- after-review commit mode/ref
- pending Bucket I count
- Bucket II count
- last validation result summary
- whether checkpoint compaction is pending

### `/post-review-loop pause`

Pauses automatic continuation. Preserve all state.

### `/post-review-loop resume`

Resumes from the persisted phase and sends the appropriate phase prompt.

### `/post-review-loop stop`

Stops the loop and renders a final report from the current ledger. If validated loop fixes exist and the after-review commit policy allows it, create/amend the loop-owned after-review commit before reporting.

### `/post-review-loop report`

Renders the current deterministic report without changing phase, except for safe report-only state normalization.

## Model-facing tools

Register a small tool surface. Prefer one structured submission tool over many tiny tools.

### `post_review_loop_get_state`

Returns the current loop state and the next required action.

Use when the model is unsure what phase it is in.

### `post_review_loop_submit_phase_result`

The model calls this at the end of each phase.

Input shape should include:

- `phase`
- `iteration`
- `summary`
- `changedFiles`
- `validation`
- `bucketI`
- `bucketII`
- `rejectedOrKeptAsIs`
- `codeChanges`
- phase-specific fields:
  - `post-review`: Bucket I candidates
  - `impl-review`: accepted/rejected/downgraded Bucket I items and implementation plan
  - `impl`: applied fixes and validation evidence

The extension validates the payload, updates the ledger, runs the gate, then either:

- checkpoints and continues to the next phase
- renders the final report
- stops with a clear error if the result is invalid

### Optional: `post_review_loop_abort`

Allows the model to stop with a structured reason when scope, context, validation, or user approval blocks safe continuation.

## Phase state machine

Use this phase rhythm:

```text
post-review -> impl-review -> impl -> post-review -> ... -> final-report
```

### `post-review`

Model task:

- inspect current diff and relevant files
- produce Bucket I candidates and Bucket II items
- do not edit code

Gate:

- no Bucket I candidates -> final report
- only Bucket II remains -> final report
- iteration limit reached -> final report
- Bucket I candidates exist -> checkpoint to `impl-review`

### `impl-review`

Model task:

- verify each Bucket I candidate against real code paths
- accept, reject, downgrade, or move to Bucket II
- produce a concrete implementation plan for accepted Bucket I
- do not edit code

Gate:

- no accepted/actionable Bucket I -> final report
- only Bucket II remains -> final report
- iteration limit reached -> final report
- accepted Bucket I exists -> checkpoint to `impl`

### `impl`

Model task:

- implement only accepted Bucket I fixes
- run focused validation
- report applied fixes and evidence

Gate:

- no Bucket I fixes applied -> final report
- fixes applied -> checkpoint to next `post-review`

## Deterministic gate logic

Port the existing `scripts/loop-decision` behavior into TypeScript in `gate.ts`.

The gate should accept a normalized phase snapshot and return exactly one of:

```ts
type GateDecision =
  | { decision: "continue"; nextPhase: Phase; checkpointRequired: true; reason: string }
  | { decision: "stop"; nextPhase: "final-report"; checkpointRequired: false; reason: string; verdict: Verdict };
```

Stop reasons should map deterministically to final verdicts:

- no accepted/actionable Bucket I remains -> `Loop clean: no accepted/actionable Bucket I findings remain`
- only Bucket II remains -> `Loop stopped: Bucket II decision needed`
- iteration limit reached -> `Loop stopped: iteration limit reached`
- validation failure remains -> `Loop stopped: validation failure remains`
- scope/context missing -> `Loop stopped: scope or context needed`
- checkpoint unavailable -> `Loop stopped: phase checkpoint unavailable`

## Final report renderer

Port the existing `scripts/final-report` behavior into `report.ts`.

The report should remain deterministic and end with one exact verdict line.

Required sections:

- `# Post-Implementation Review Loop Report`
- `## Summary`
- `## Phases Run`
- `## Validation`
- `## Bucket I — Findings and Fixes`
- `## Bucket II — Findings and Recommendations`
- `## Code Changes Applied`
- `## Rejected / Kept As-Is`
- `## Final Verdict`

Do not let the model freehand the final report. The model supplies facts; the extension renders the report.

## State persistence

Use `pi.appendEntry(...)` with a custom type such as:

```text
post-review-loop-state
```

Persist after every meaningful transition:

- loop started
- baseline established
- phase result submitted
- gate decision made
- checkpoint requested
- checkpoint completed
- loop paused/resumed/stopped
- report rendered

On `session_start`, restore the latest state from session entries.

On reload, prefer safe behavior:

- if a loop was active, restore it as paused or active-but-not-auto-continuing
- notify the user how to resume

## Status UI

Set a compact status item while a loop exists:

```text
pr-loop: post-review 1/5
pr-loop: checkpointing -> impl
pr-loop: paused impl-review 2/5
```

Clear the status when the loop is stopped/cleared.

## Compaction behavior

The extension should absorb or replace the current `phase_checkpoint_compact` behavior.

At a continuing gate:

1. Persist checkpoint state.
2. Temporarily lower thinking level to `low` for compaction.
3. Trigger `ctx.compact(...)` with a focused handoff.
4. Block extra tool calls while checkpointing if needed.
5. Restore the previous thinking level.
6. Send the next phase prompt as a follow-up user message.

If compaction fails:

- restore thinking level
- mark checkpoint failure in state
- notify the user
- ask whether to continue without real compaction, retry, or stop

Do not expose this as a generic compaction tool. It is part of the loop controller.

## Git policy

Implement this conservatively in `git.ts`.

Before first active phase:

1. Inspect `git status --short`.
2. Determine scoped files.
3. If unrelated dirty files cannot be separated safely, stop and ask the user.
4. If clean, record current `HEAD` as baseline.
5. If scoped implementation changes are dirty, create or amend only a loop-owned before-review commit:

```text
review(post-review): before review
```

Commit body marker:

```text
Post-review-loop before-review

Captures the implementation state before automated post-review fixes.
Loop fixes should appear in a later after-review commit.
```

After loop fixes:

- if fixes were applied and validation passed, create/amend only a loop-owned after-review commit:

```text
review(post-review): after review
```

Commit body marker:

```text
Post-review-loop after-review

Applies validated automated post-review fixes on top of the before-review baseline.
```

Never amend normal user commits unless the user explicitly asks.
Never push.
Never stage unrelated files.

## Prompt design

Keep prompts in `prompts.ts`, not buried inside command handlers.

Prompts should be phase-specific and short enough to inspect.

Each phase prompt must include:

- current goal/scope
- phase name
- iteration count/limit
- exact allowed behavior
- expected tool call at phase end
- reminder to inspect real files/diff, not just prior summaries

The review rubric should also live in `prompts.ts`:

- Bucket I: concrete, worthwhile, safe, in-scope, clear fix path
- Bucket II: real but needs user/product/architecture/scope decision
- reject speculative, noisy, unrealistic, optional polish
- prefer root-cause design fixes over bandages
- do not manufacture findings

## Validation strategy

Use the repository's existing workflow. Do not invent commands.

The extension should not decide which tests to run, but it should require the model to report validation as structured records:

```ts
type ValidationResult = {
  command: string;
  result: "passed" | "failed" | "skipped";
  phase: Phase;
  notes: string;
};
```

For no-edit phases, require a skipped validation record such as:

```text
Review/planning phase; no code changes to validate
```

## Migration plan

### Phase 1 — scaffolding

- Create `extensions/post-review-loop/`.
- Add `index.ts`, `types.ts`, `state.ts`, `prompts.ts`, `gate.ts`, `report.ts`.
- Register commands and a minimal `post_review_loop_get_state` tool.
- Validate the extension loads.

### Phase 2 — deterministic gate and report

- Port `loop-decision` to `gate.ts`.
- Port `final-report` to `report.ts`.
- Add unit-like local validation through small TypeScript or Node scripts if repo conventions allow.

### Phase 3 — state and status

- Persist state with `pi.appendEntry`.
- Restore on `session_start`.
- Show status bar state.
- Implement `/status`, `/pause`, `/resume`, `/stop`, `/report`.

### Phase 4 — model phase submission

- Implement `post_review_loop_submit_phase_result`.
- Validate schema strictly.
- Update ledger from submissions.
- Run gate after every submission.

### Phase 5 — compaction continuation

- Integrate checkpoint compaction behavior.
- Send next-phase prompts after compaction.
- Protect against duplicate checkpoints and extra tool calls while pending.
- Decide whether to keep `phase_checkpoint_compact` as a separate lower-level extension or deprecate it.

### Phase 6 — git baseline and after-review commits

- Implement scoped status inspection.
- Implement loop-owned before-review commit creation/amend.
- Implement loop-owned after-review commit creation/amend.
- Add clear refusal behavior when scope is ambiguous.

### Phase 7 — retire/reduce the skill

- Replace the current long skill with a short note or remove it from normal use.
- The note should tell users to run `/post-review-loop start`.
- Ensure no phase table or report schema remains duplicated in a maintained skill.

## Acceptance criteria

The implementation is complete when:

- `/post-review-loop start` begins a loop and sends a `post-review` prompt.
- `/post-review-loop status` accurately shows active state.
- The model can submit structured phase results through a tool.
- The extension, not the model, decides stop vs continue.
- Continuing phases compact and resume automatically.
- Final reports are rendered deterministically by extension code.
- Loop state survives reload/resume.
- Git baseline and after-review commits are loop-owned and conservative.
- The old skill is no longer a parallel source of workflow truth.

## Non-goals for v1

- Fully deterministic code review.
- Replacing model judgment with static analysis.
- Supporting arbitrary custom phase graphs.
- Multi-agent orchestration UI.
- Pushing commits or opening PRs.
- Global installation or packaging beyond this repo's extension layout.

## Risks and mitigations

### Risk: hidden prompt complexity

Mitigation: keep all prompts in `prompts.ts`, with clear names and comments.

### Risk: unsafe git automation

Mitigation: only touch loop-owned commits, stage scoped files only, refuse ambiguous dirty trees.

### Risk: extension becomes too large

Mitigation: keep deterministic modules small and pure where possible: `gate.ts`, `report.ts`, and type validators should have minimal Pi dependencies.

### Risk: model submits bad or incomplete phase data

Mitigation: strict schema validation, clear error messages, and `post_review_loop_get_state` for recovery.

### Risk: compaction failure breaks the loop

Mitigation: persist checkpoint state before compaction and provide retry/continue/stop recovery commands.

## Open decisions

- Should the existing `phase_checkpoint_compact` extension remain as a reusable primitive, or should this extension fully absorb it?
- Should `/post-review-loop start` auto-create the before-review commit by default, or ask once before enabling git automation?
- Should the extension support a `--review-only` start mode?
- Should iteration limit be command-configurable, e.g. `/post-review-loop start --limit 3 <scope>`?
- Should the extension expose a custom TUI view for ledger inspection, or keep v1 to notifications/status/report output?
