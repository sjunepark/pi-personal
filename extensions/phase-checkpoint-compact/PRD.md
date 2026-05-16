# Phase Checkpoint Compaction Extension PRD

## Goal

Create a Pi extension that gives agents a safe, narrow way to request real context compaction at explicit workflow phase boundaries.

Primary consumer: a future `post-implementation-review-loop` skill that wants this rhythm:

```text
impl -> compact -> post review -> impl review -> compact -> post review -> impl -> ...
```

The extension should provide the compaction primitive. The skill should provide the review/implementation protocol.

## Problem

Pi already supports compaction through auto-compaction, `/compact`, SDK/RPC, and extension APIs. A plain skill can only instruct the model to checkpoint; it cannot reliably force a real compaction or continue the next phase after compaction.

For looped review workflows, a soft checkpoint is not enough. The agent needs a phase-boundary handoff that:

1. records the loop state,
2. triggers real Pi compaction with focused instructions,
3. resumes the agent in the next phase after compaction completes.

## Non-goals

- Do not expose a generic `compact_now` tool for arbitrary agent use.
- Do not replace Pi's built-in automatic threshold compaction.
- Do not implement the post-implementation review logic in this extension.
- Do not commit, push, install skills, or mutate repo state beyond session messages/compaction.
- Do not preserve verbose reasoning traces, raw tool dumps, or stale alternatives in compaction handoffs.

## Product Behavior

Register one agent-callable tool:

```text
phase_checkpoint_compact
```

The agent calls this only when it reaches a workflow boundary and is ready to stop the current phase.

High-level flow:

```text
agent completes phase
-> agent calls phase_checkpoint_compact({ phaseCompleted, nextPhase, handoff... })
-> tool records checkpoint and temporarily lowers Pi's thinking level/default to low
-> tool starts ctx.compact(...)
-> tool result tells agent to stop substantial work for this turn
-> on compaction complete, extension restores the prior thinking level and sends the next phase prompt
```

If compaction fails, the extension should notify the user and send/return a soft-checkpoint fallback prompt asking whether to continue without real compaction.

## Tool Contract

### Name

`phase_checkpoint_compact`

### Description

Request real Pi compaction at an approved workflow phase boundary, preserving a concise handoff for the next phase.

### Parameters

Use TypeBox or the existing extension style in this repo.

```ts
type PhaseName = "impl" | "post-review" | "impl-review" | "stop";

type ValidationResult = {
  command: string;
  result: "passed" | "failed" | "skipped";
  notes?: string;
};

type BucketIIItem = {
  title: string;
  finding: string;
  options?: string[];
  recommendedAction:
    | "Discuss before changing"
    | "Defer"
    | "Keep as-is for now"
    | "Prototype separately"
    | "Implement next if approved";
  reason: string;
  risksOrTradeoffs?: string;
};

type PhaseCheckpointInput = {
  phaseCompleted: PhaseName;
  nextPhase: PhaseName;
  goal: string;
  scope: string;
  changedFiles: string[];
  validation: ValidationResult[];
  bucketIApplied: string[];
  bucketIRemaining: string[];
  bucketII: BucketIIItem[];
  rejectedOrKeptAsIs: string[];
  handoffSummary: string;
};
```

Validation rules:

- `phaseCompleted` and `nextPhase` are required.
- `handoffSummary` is required and should be concise.
- `changedFiles` should contain repo-relative paths when known.
- `bucketIRemaining` should normally be empty when `nextPhase` is `post-review`; if not empty, the next prompt should explicitly ask the agent to verify/apply them.
- `nextPhase: "stop"` should compact/checkpoint but should not auto-send another phase prompt unless useful to report completion.

## Compaction Instructions

The extension should build focused custom instructions for `ctx.compact(...)` from the tool input.

Suggested instruction text:

```text
Preserve only the phase-loop handoff needed to continue after compaction.

Keep:
- current goal and scope
- phase completed and next phase
- changed files and important seams
- validation commands and results
- Bucket I actions already applied
- Bucket I findings still remaining, if any
- Bucket II items with recommended actions and tradeoffs
- rejected or kept-as-is findings and why
- concise next-step instructions

Drop:
- stale alternatives
- raw tool output dumps
- long reasoning traces
- implementation details not needed for the next phase
- review findings that were rejected and no longer matter
```

Append a structured handoff block derived from the tool input.

## Next Phase Prompts

After compaction completes, the extension should call `pi.sendUserMessage(...)` with a concise prompt for `nextPhase`.

Examples:

### `nextPhase: "post-review"`

```text
Continue the phase-checkpoint loop at post-review.

Re-read the current diff and relevant files. Do not rely only on the compacted summary. Produce Bucket I and Bucket II findings. Do not edit code in this phase. For Bucket II, include a recommended action.
```

### `nextPhase: "impl-review"`

```text
Continue the phase-checkpoint loop at impl-review.

Verify the latest post-review findings against the actual code paths and tests. Accept, reject, or downgrade findings. Convert accepted Bucket I findings into a concrete implementation plan. Keep Bucket II as decisions with recommended actions. Do not edit code unless the plan is already accepted as Bucket I.
```

### `nextPhase: "impl"`

```text
Continue the phase-checkpoint loop at impl.

Apply only accepted Bucket I actions or a user-approved Bucket II direction. Keep the change tight, rerun focused validation, then call phase_checkpoint_compact for the next phase boundary.
```

### `nextPhase: "stop"`

Do not auto-continue. Optionally send a short completion prompt/report request.

## Guardrails

- The tool result must tell the agent: checkpoint accepted; do not continue substantial work in this turn; wait for the post-compaction next-phase prompt.
- Keep an in-memory `checkpointPending` flag while compaction is in progress.
- If additional tool calls happen while `checkpointPending` is true, consider blocking them through `tool_call` with a clear reason, except for harmless final reporting if blocking all tools is too disruptive.
- Avoid recursive compaction: ignore or reject a second checkpoint request while one is pending.
- Notify the user on compaction start, success, and failure when UI is available.
- Temporarily set Pi's thinking level to `low` when the checkpoint is accepted, then restore the previously captured level before the post-compaction continuation prompt is sent.
- If `ctx.compact` is unavailable or fails, return a soft-checkpoint result and send a prompt asking whether to continue without real compaction.

## Implementation Notes

Relevant Pi APIs:

- `pi.registerTool(...)` registers the agent-callable checkpoint tool.
- Tool `execute(..., ctx)` receives an extension context.
- `ctx.compact({ customInstructions, onComplete, onError })` triggers compaction asynchronously.
- `pi.sendUserMessage(content, { deliverAs: "followUp" })` can resume the next phase after compaction.
- `pi.on("tool_call", ...)` can block later tool calls while compaction is pending.

Skeleton shape:

```ts
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let checkpointPending = false;

  pi.registerTool({
    name: "phase_checkpoint_compact",
    label: "Phase Checkpoint Compact",
    description: "Request real Pi compaction at a workflow phase boundary and resume the next phase after compaction.",
    promptSnippet: "Request phase-boundary compaction before continuing a looped workflow.",
    promptGuidelines: [
      "Use phase_checkpoint_compact only at an explicit phase boundary after preserving the loop handoff.",
      "After calling phase_checkpoint_compact, do not continue substantial work until the next phase prompt arrives.",
    ],
    parameters: Type.Object({
      phaseCompleted: StringEnum(["impl", "post-review", "impl-review", "stop"] as const),
      nextPhase: StringEnum(["impl", "post-review", "impl-review", "stop"] as const),
      goal: Type.String(),
      scope: Type.String(),
      changedFiles: Type.Array(Type.String()),
      validation: Type.Array(Type.Object({
        command: Type.String(),
        result: StringEnum(["passed", "failed", "skipped"] as const),
        notes: Type.Optional(Type.String()),
      })),
      bucketIApplied: Type.Array(Type.String()),
      bucketIRemaining: Type.Array(Type.String()),
      bucketII: Type.Array(Type.Object({
        title: Type.String(),
        finding: Type.String(),
        options: Type.Optional(Type.Array(Type.String())),
        recommendedAction: StringEnum([
          "Discuss before changing",
          "Defer",
          "Keep as-is for now",
          "Prototype separately",
          "Implement next if approved",
        ] as const),
        reason: Type.String(),
        risksOrTradeoffs: Type.Optional(Type.String()),
      })),
      rejectedOrKeptAsIs: Type.Array(Type.String()),
      handoffSummary: Type.String(),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (checkpointPending) {
        return { content: [{ type: "text", text: "Checkpoint already pending; do not request another compaction." }] };
      }

      checkpointPending = true;
      const customInstructions = buildCompactionInstructions(params);

      if (ctx.hasUI) ctx.ui.notify("Phase checkpoint compaction started", "info");

      ctx.compact({
        customInstructions,
        onComplete: () => {
          checkpointPending = false;
          if (ctx.hasUI) ctx.ui.notify("Phase checkpoint compaction completed", "info");
          if (params.nextPhase !== "stop") {
            pi.sendUserMessage(buildNextPhasePrompt(params), { deliverAs: "followUp" });
          }
        },
        onError: (error) => {
          checkpointPending = false;
          if (ctx.hasUI) ctx.ui.notify(`Phase checkpoint compaction failed: ${error.message}`, "error");
          pi.sendUserMessage(buildCompactionFailurePrompt(params, error), { deliverAs: "followUp" });
        },
      });

      return {
        content: [{
          type: "text",
          text: "Phase checkpoint accepted. Stop substantial work for this turn; the extension will resume the next phase after compaction.",
        }],
      };
    },
  });

  pi.on("tool_call", (event) => {
    if (!checkpointPending) return;
    if (event.toolName === "phase_checkpoint_compact") return { block: true, reason: "Checkpoint compaction is already pending." };
    return { block: true, reason: "Checkpoint compaction is pending; finish the turn without more tool calls." };
  });
}
```

The skeleton is illustrative. Adjust imports and helper types to match the current Pi extension APIs and this repo's extension style.

## Acceptance Criteria

1. Pi loads the extension without TypeScript/runtime errors.
2. The agent sees `phase_checkpoint_compact` as an available tool with clear guidelines.
3. Calling the tool temporarily sets Pi's thinking level/default to `low` and starts real Pi compaction with focused instructions.
4. The tool returns a clear stop-work message to the agent.
5. After compaction succeeds, the extension restores the prior thinking level and sends the correct next-phase prompt.
6. If compaction fails, the extension reports failure and offers a soft-checkpoint continuation path.
7. Duplicate checkpoint requests while pending are rejected.
8. The future loop skill can state: "Requires the `phase_checkpoint_compact` Pi extension tool; otherwise use soft checkpoints."

## Open Questions

- Should the extension store checkpoint history in memory only, or append a custom session message for observability?
- Should `tool_call` blocking allow read-only tools after checkpoint, or block all tools to force phase closure?
- Should the extension expose a command like `/phase-checkpoint-status` for debugging pending state?
- Should next-phase prompt text be configurable globally, or hardcoded for the first version?
