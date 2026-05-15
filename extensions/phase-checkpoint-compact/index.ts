import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const TOOL_NAME = "phase_checkpoint_compact";
const ENTRY_TYPE = "phase-checkpoint-compact";
const DEFAULT_THINKING_LEVEL: ReturnType<ExtensionAPI["getThinkingLevel"]> = "low";

type PhaseName = "impl" | "post-review" | "impl-review" | "stop";
type ValidationStatus = "passed" | "failed" | "skipped";
type RecommendedAction =
	| "Discuss before changing"
	| "Defer"
	| "Keep as-is for now"
	| "Prototype separately"
	| "Implement next if approved";

type ValidationResult = {
	command: string;
	result: ValidationStatus;
	notes?: string;
};

type BucketIIItem = {
	title: string;
	finding: string;
	options?: string[];
	recommendedAction: RecommendedAction;
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

type ToolTextResult = {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
	terminate?: boolean;
};

const PHASE_SCHEMA = Type.Union([Type.Literal("impl"), Type.Literal("post-review"), Type.Literal("impl-review"), Type.Literal("stop")]);
const VALIDATION_STATUS_SCHEMA = Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("skipped")]);
const RECOMMENDED_ACTION_SCHEMA = Type.Union([
	Type.Literal("Discuss before changing"),
	Type.Literal("Defer"),
	Type.Literal("Keep as-is for now"),
	Type.Literal("Prototype separately"),
	Type.Literal("Implement next if approved"),
]);

const PHASE_CHECKPOINT_SCHEMA = Type.Object({
	phaseCompleted: PHASE_SCHEMA,
	nextPhase: PHASE_SCHEMA,
	goal: Type.String({ minLength: 1 }),
	scope: Type.String({ minLength: 1 }),
	changedFiles: Type.Array(Type.String()),
	validation: Type.Array(
		Type.Object({
			command: Type.String({ minLength: 1 }),
			result: VALIDATION_STATUS_SCHEMA,
			notes: Type.Optional(Type.String()),
		}),
	),
	bucketIApplied: Type.Array(Type.String()),
	bucketIRemaining: Type.Array(Type.String()),
	bucketII: Type.Array(
		Type.Object({
			title: Type.String({ minLength: 1 }),
			finding: Type.String({ minLength: 1 }),
			options: Type.Optional(Type.Array(Type.String())),
			recommendedAction: RECOMMENDED_ACTION_SCHEMA,
			reason: Type.String({ minLength: 1 }),
			risksOrTradeoffs: Type.Optional(Type.String()),
		}),
	),
	rejectedOrKeptAsIs: Type.Array(Type.String()),
	handoffSummary: Type.String({ minLength: 1 }),
});

function textToolResult(text: string, details: Record<string, unknown>, isError = false): ToolTextResult {
	return {
		content: [{ type: "text", text }],
		details,
		isError,
		terminate: true,
	};
}

function compactLine(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function formatList(items: string[], empty = "- none"): string {
	const cleaned = items.map(compactLine).filter(Boolean);
	return cleaned.length ? cleaned.map((item) => `- ${item}`).join("\n") : empty;
}

function formatValidation(items: ValidationResult[]): string {
	if (!items.length) return "- none";
	return items
		.map((item) => {
			const notes = item.notes?.trim() ? ` — ${compactLine(item.notes)}` : "";
			return `- ${item.result}: \`${item.command.trim()}\`${notes}`;
		})
		.join("\n");
}

function formatBucketII(items: BucketIIItem[]): string {
	if (!items.length) return "- none";
	return items
		.map((item) => {
			const parts = [
				`- ${compactLine(item.title)}`,
				`  - finding: ${compactLine(item.finding)}`,
				item.options?.length ? `  - options: ${item.options.map(compactLine).filter(Boolean).join("; ")}` : undefined,
				`  - recommended action: ${item.recommendedAction}`,
				`  - reason: ${compactLine(item.reason)}`,
				item.risksOrTradeoffs?.trim() ? `  - risks/tradeoffs: ${compactLine(item.risksOrTradeoffs)}` : undefined,
			];
			return parts.filter(Boolean).join("\n");
		})
		.join("\n");
}

function buildHandoffBlock(params: PhaseCheckpointInput): string {
	return `## Phase checkpoint handoff

- Goal: ${compactLine(params.goal)}
- Scope: ${compactLine(params.scope)}
- Phase completed: ${params.phaseCompleted}
- Next phase: ${params.nextPhase}

### Handoff summary
${params.handoffSummary.trim()}

### Changed files
${formatList(params.changedFiles)}

### Validation
${formatValidation(params.validation)}

### Bucket I applied
${formatList(params.bucketIApplied)}

### Bucket I remaining
${formatList(params.bucketIRemaining)}

### Bucket II decisions / discussion items
${formatBucketII(params.bucketII)}

### Rejected or kept as-is
${formatList(params.rejectedOrKeptAsIs)}`;
}

function buildCompactionInstructions(params: PhaseCheckpointInput): string {
	return `Preserve only the phase-loop handoff needed to continue after compaction.

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

${buildHandoffBlock(params)}`;
}

function buildRemainingBucketIPrompt(params: PhaseCheckpointInput): string {
	if (!params.bucketIRemaining.length) return "";
	const remaining = formatList(params.bucketIRemaining);
	return `\n\nRemaining Bucket I items from the checkpoint:\n${remaining}\n\nVerify these against the actual diff before proceeding. If this is a no-edit phase, report still-valid items instead of editing.`;
}

function buildNextPhasePrompt(params: PhaseCheckpointInput): string | undefined {
	if (params.nextPhase === "stop") return undefined;

	if (params.nextPhase === "post-review") {
		return `Continue the phase-checkpoint loop at post-review.

Re-read the current diff and relevant files. Do not rely only on the compacted summary. Produce Bucket I and Bucket II findings. Do not edit code in this phase. For Bucket II, include a recommended action.${buildRemainingBucketIPrompt(params)}`;
	}

	if (params.nextPhase === "impl-review") {
		return `Continue the phase-checkpoint loop at impl-review.

Verify the latest post-review findings against the actual code paths and tests. Accept, reject, or downgrade findings. Convert accepted Bucket I findings into a concrete implementation plan. Keep Bucket II as decisions with recommended actions. Do not edit code unless the plan is already accepted as Bucket I.${buildRemainingBucketIPrompt(params)}`;
	}

	return `Continue the phase-checkpoint loop at impl.

Apply only accepted Bucket I actions or a user-approved Bucket II direction. Keep the change tight, rerun focused validation, then call phase_checkpoint_compact for the next phase boundary.${buildRemainingBucketIPrompt(params)}`;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function buildCompactionFailurePrompt(params: PhaseCheckpointInput, error: unknown): string {
	const nextPhasePrompt = buildNextPhasePrompt(params);
	return `Phase checkpoint compaction failed: ${getErrorMessage(error)}

Use this as a soft checkpoint only. Do not assume real compaction happened. Ask the user whether to continue without real compaction, retry later, or stop.

${buildHandoffBlock(params)}${nextPhasePrompt ? `\n\nIf the user approves continuing without real compaction, the intended next-phase prompt was:\n\n${nextPhasePrompt}` : ""}`;
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(message, type);
}

function applyDefaultThinkingLevel(pi: ExtensionAPI): void {
	if (pi.getThinkingLevel() === DEFAULT_THINKING_LEVEL) return;
	pi.setThinkingLevel(DEFAULT_THINKING_LEVEL);
}

type QueuedCheckpoint = {
	toolCallId: string;
	params: PhaseCheckpointInput;
	started: boolean;
};

export default function phaseCheckpointCompact(pi: ExtensionAPI): void {
	let queuedCheckpoint: QueuedCheckpoint | undefined;

	function clearPending(): void {
		queuedCheckpoint = undefined;
	}

	pi.registerTool({
		name: TOOL_NAME,
		label: "Phase Checkpoint Compact",
		description: "Request real Pi compaction at an approved workflow phase boundary and resume the next phase after compaction.",
		promptSnippet: "Request phase-boundary compaction before continuing a looped workflow.",
		promptGuidelines: [
			"Use phase_checkpoint_compact only at an explicit workflow phase boundary after preserving the loop handoff.",
			"After calling phase_checkpoint_compact, do not continue substantial work until the next phase prompt arrives.",
			"Do not use phase_checkpoint_compact as a generic compaction tool or during ordinary implementation work.",
		],
		parameters: PHASE_CHECKPOINT_SCHEMA,
		executionMode: "sequential",
		async execute(toolCallId, params: PhaseCheckpointInput, _signal, _onUpdate, ctx) {
			if (queuedCheckpoint) {
				return textToolResult("Checkpoint compaction is already pending; do not request another compaction.", { pending: true }, true);
			}

			const trimmedHandoff = params.handoffSummary.trim();
			if (!trimmedHandoff) {
				return textToolResult("handoffSummary must not be empty.", { pending: false }, true);
			}

			applyDefaultThinkingLevel(pi);

			pi.appendEntry(ENTRY_TYPE, {
				timestamp: Date.now(),
				phaseCompleted: params.phaseCompleted,
				nextPhase: params.nextPhase,
				checkpoint: params,
			});

			if (typeof ctx.compact !== "function") {
				clearPending();
				notify(ctx, "Phase checkpoint compaction is unavailable; queued soft-checkpoint fallback.", "warning");
				pi.sendUserMessage(buildCompactionFailurePrompt(params, "ctx.compact is unavailable"), { deliverAs: "followUp" });
				return textToolResult(
					"Real compaction is unavailable. A soft-checkpoint fallback has been queued. Stop substantial work for this turn and wait for the follow-up prompt.",
					{ pending: false, compacted: false },
					true,
				);
			}

			queuedCheckpoint = { toolCallId, params, started: false };
			notify(ctx, "Phase checkpoint queued; compaction will start after this agent run ends", "info");

			return textToolResult(
				"Phase checkpoint accepted. Stop substantial work for this turn; the extension will compact after this agent run ends and resume the next phase afterward.",
				{ pending: true, compacted: false, nextPhase: params.nextPhase },
			);
		},
	});

	pi.on("tool_call", (event) => {
		if (!queuedCheckpoint) return undefined;
		if (event.toolName === TOOL_NAME) return { block: true, reason: "Checkpoint compaction is already pending." };
		return { block: true, reason: "Checkpoint compaction is pending; finish the turn without more tool calls." };
	});

	pi.on("agent_end", (_event, ctx) => {
		const checkpoint = queuedCheckpoint;
		if (!checkpoint || checkpoint.started) return;

		checkpoint.started = true;
		const { params } = checkpoint;
		const customInstructions = buildCompactionInstructions(params);
		notify(ctx, "Phase checkpoint compaction started", "info");

		try {
			ctx.compact({
				customInstructions,
				onComplete: () => {
					clearPending();
					applyDefaultThinkingLevel(pi);
					notify(ctx, "Phase checkpoint compaction completed", "info");
					const prompt = buildNextPhasePrompt(params);
					if (prompt) pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				},
				onError: (error) => {
					clearPending();
					applyDefaultThinkingLevel(pi);
					notify(ctx, `Phase checkpoint compaction failed: ${getErrorMessage(error)}`, "error");
					pi.sendUserMessage(buildCompactionFailurePrompt(params, error), { deliverAs: "followUp" });
				},
			});
		} catch (error) {
			clearPending();
			applyDefaultThinkingLevel(pi);
			notify(ctx, `Phase checkpoint compaction failed: ${getErrorMessage(error)}`, "error");
			pi.sendUserMessage(buildCompactionFailurePrompt(params, error), { deliverAs: "followUp" });
		}
	});

	pi.on("session_shutdown", () => {
		clearPending();
	});
}
