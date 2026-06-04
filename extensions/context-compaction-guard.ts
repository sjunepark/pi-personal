import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

type ContextUsage = ReturnType<ExtensionContext["getContextUsage"]>;
type ToolTextResult = { content: Array<{ type: "text"; text: string }>; details?: unknown; terminate?: boolean };

type GuardState = {
	alertedThresholds?: number[];
	lastAlert?: {
		threshold: number;
		percent: number | null;
		tokens: number | null;
		timestamp: number;
	};
	lastCompaction?: {
		requestId: string;
		summaryChars: number;
		tokensBefore: number;
		timestamp: number;
	};
};

type PendingCompaction = {
	requestId: string;
	summary: string;
	threshold?: number;
	usage: ContextUsage;
	requestedAt: number;
	started: boolean;
	completed: boolean;
};

const ENTRY_TYPE = "context-compaction-guard-state";
const MESSAGE_TYPE = "context-compaction-guard";
const THRESHOLDS = [40, 50, 60, 70] as const;
const URGENT_THRESHOLD = 70;
const FULL_REPLACEMENT_SENTINEL = "context-compaction-guard:no-kept-entry";

let alertedThresholds = new Set<number>();
let pendingCompaction: PendingCompaction | null = null;
let scheduledMessage: ReturnType<typeof setTimeout> | null = null;
let scheduleVersion = 0;

function textToolResult(text: string, details?: unknown, terminate = false): ToolTextResult {
	return { content: [{ type: "text", text }], details, terminate };
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

function formatUsage(usage: ContextUsage): string {
	if (!usage) return "context usage unavailable";
	const percent = usage.percent === null ? "unknown" : `${usage.percent.toFixed(1)}%`;
	const tokens = usage.tokens === null ? "unknown tokens" : `${usage.tokens.toLocaleString()} tokens`;
	return `${percent} (${tokens} / ${usage.contextWindow.toLocaleString()})`;
}

function customMessage(content: string, details?: unknown): any {
	return {
		role: "custom",
		customType: MESSAGE_TYPE,
		content,
		display: true,
		details,
		timestamp: Date.now(),
	};
}

function restoreState(ctx: ExtensionContext): void {
	let latest: GuardState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
			latest = entry.data as GuardState;
		}
	}
	alertedThresholds = new Set((latest?.alertedThresholds ?? []).filter((threshold) => THRESHOLDS.includes(threshold as (typeof THRESHOLDS)[number])));
}

function persistState(pi: ExtensionAPI, state: GuardState = {}): void {
	pi.appendEntry(ENTRY_TYPE, {
		alertedThresholds: Array.from(alertedThresholds).sort((a, b) => a - b),
		...state,
	});
}

function crossedThreshold(usage: ContextUsage): number | undefined {
	if (!usage || usage.percent === null) return undefined;
	const crossed = THRESHOLDS.filter((threshold) => usage.percent! >= threshold && !alertedThresholds.has(threshold));
	return crossed.at(-1);
}

function markThresholdsThrough(threshold: number): void {
	for (const candidate of THRESHOLDS) {
		if (candidate <= threshold) alertedThresholds.add(candidate);
	}
}

function buildThresholdAdvisory(threshold: number, usage: ContextUsage): string {
	const urgent = threshold >= URGENT_THRESHOLD;
	return `Context compaction checkpoint: current context usage crossed ${threshold}% (${formatUsage(usage)}).

This is an agent-facing context-engineering checkpoint, not a request for the human user. Decide automatically whether to compact before continuing.

Why this option exists:
- Agents often lose focus as context grows; degradation is commonly noticeable around or after ~70% usage.
- Good context engineering keeps the smallest high-signal working context, not every historical token.
- Even before 70%, replacing low-value history with a dense working context can improve long-run output quality.
- Compaction should not be overused: weak compaction can cause repeated reads of files already inspected, wasting time and filling context again.

${urgent ? "Urgency: HIGH. Strongly consider compacting now unless the task is about to finish or you cannot produce a high-fidelity compacted context yet." : "Urgency: moderate. Compact only if you can preserve the details needed to continue without avoidable rereads."}

If you choose to compact, call compact_conversation with a high-fidelity compacted working context. The summary may be long. It is for an LLM, not for a human skim.

A good compacted context should include:
## Current task
## User constraints and preferences
## Current state / progress
## Key decisions and rationale
## Files and code already inspected
- Include exact paths.
- For important files, include the relevant content, snippets, APIs, invariants, and conclusions.
- For small central files, include full content when that prevents rereading.
- Do not merely list paths if the file contents are likely needed after compaction.
## Files modified / pending edits
## Commands and validation results
## Errors, blockers, and open questions
## Next actions

If you choose not to compact, silently continue the user's task. Do not ask the human for confirmation.`;
}

function buildCompactionCompleteMessage(result: { summaryChars: number; tokensBefore: number }): string {
	return `Agent-driven context compaction completed.

The previous conversation context was replaced with the high-fidelity compacted working context you submitted (${result.summaryChars.toLocaleString()} chars, replacing about ${result.tokensBefore.toLocaleString()} tokens before compaction).

Continue the user's task from this compacted context. Avoid rereading files whose needed contents are already captured; reread only when the compacted context is insufficient, stale, or exact current file contents are required.`;
}

function buildCompactionFailedMessage(error: Error): string {
	return `Agent-driven context compaction failed: ${error.message}

Continue the user's task using the current context. Do not retry compaction immediately unless you can address the failure and the context remains high enough to justify it.`;
}

function clearScheduledMessage(): void {
	scheduleVersion += 1;
	if (!scheduledMessage) return;
	clearTimeout(scheduledMessage);
	scheduledMessage = null;
}

function sendAgentMessageWhenIdle(pi: ExtensionAPI, ctx: ExtensionContext, content: string, details?: unknown): void {
	clearScheduledMessage();
	const version = scheduleVersion;
	const poll = () => {
		if (version !== scheduleVersion) return;
		if (!ctx.isIdle()) {
			scheduledMessage = setTimeout(poll, 25);
			return;
		}
		scheduledMessage = null;
		pi.sendMessage(customMessage(content, details), { deliverAs: "followUp", triggerTurn: true });
	};
	scheduledMessage = setTimeout(poll, 25);
}

function completePendingCompaction(pi: ExtensionAPI, ctx: ExtensionContext, tokensBefore: number): void {
	const pending = pendingCompaction;
	if (!pending || pending.completed) return;
	pending.completed = true;
	const result = {
		requestId: pending.requestId,
		summaryChars: pending.summary.length,
		tokensBefore,
		timestamp: Date.now(),
	};
	pendingCompaction = null;
	persistState(pi, { lastCompaction: result });
	notify(ctx, "Agent-driven context compaction completed", "info");
	sendAgentMessageWhenIdle(pi, ctx, buildCompactionCompleteMessage(result), { result });
}

function failPendingCompaction(pi: ExtensionAPI, ctx: ExtensionContext, error: Error): void {
	const pending = pendingCompaction;
	if (!pending) return;
	pendingCompaction = null;
	notify(ctx, `Agent-driven context compaction failed: ${error.message}`, "error");
	sendAgentMessageWhenIdle(pi, ctx, buildCompactionFailedMessage(error), { error: error.message, requestId: pending.requestId });
}

function runPendingCompactionAfterAgent(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const pending = pendingCompaction;
	if (!pending || pending.started) return;
	pending.started = true;
	notify(ctx, "Agent-driven context compaction started", "info");
	try {
		ctx.compact({
			customInstructions: "Use the agent-provided high-fidelity compacted working context from compact_conversation. Do not generate a separate summary.",
			onComplete: (result) => completePendingCompaction(pi, ctx, result.tokensBefore),
			onError: (error) => failPendingCompaction(pi, ctx, error),
		});
	} catch (error) {
		failPendingCompaction(pi, ctx, error instanceof Error ? error : new Error(String(error)));
	}
}

export default function contextCompactionGuard(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "compact_conversation",
		label: "Compact Conversation",
		description: "Replace previous conversation context with an agent-authored high-fidelity compacted working context.",
		promptSnippet: "Replace previous conversation context with a high-fidelity compacted working context when context usage is high.",
		promptGuidelines: [
			"Use compact_conversation only after a context-compaction checkpoint asks you to decide whether compaction is worthwhile.",
			"The compact_conversation summary should be a dense working context for an LLM, not a short human summary; include relevant file contents and exact details needed to avoid unnecessary rereads.",
			"Do not overuse compact_conversation. If the current context is still useful and not noisy, continue without compacting.",
		],
		parameters: Type.Object({
			summary: Type.String({
				minLength: 1,
				description:
					"High-fidelity compacted working context that will replace previous conversation history. It may be long and should preserve exact task state, decisions, file contents/snippets, validation, and next steps needed to continue.",
			}),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params: { summary: string }, _signal, _onUpdate, ctx) {
			if (pendingCompaction) {
				return textToolResult("A context compaction is already pending. Stop work and wait for it to complete.", { pending: true }, true);
			}

			const summary = params.summary.trim();
			if (!summary) throw new Error("summary must not be empty");

			pendingCompaction = {
				requestId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
				summary,
				threshold: Array.from(alertedThresholds).at(-1),
				usage: ctx.getContextUsage(),
				requestedAt: Date.now(),
				started: false,
				completed: false,
			};

			notify(ctx, "Agent-driven context compaction queued", "info");
			return textToolResult(
				"Compaction accepted and queued. Stop this turn now; the extension will replace previous context with your compacted working context and then continue automatically.",
				{
					requestId: pendingCompaction.requestId,
					summaryChars: summary.length,
					usage: pendingCompaction.usage,
				},
				true,
			);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		pendingCompaction = null;
		clearScheduledMessage();
		restoreState(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		pendingCompaction = null;
		clearScheduledMessage();
		restoreState(ctx);
	});

	pi.on("context", (event, ctx) => {
		if (pendingCompaction) return;
		const usage = ctx.getContextUsage();
		const threshold = crossedThreshold(usage);
		if (!threshold) return;

		markThresholdsThrough(threshold);
		persistState(pi, {
			lastAlert: {
				threshold,
				percent: usage?.percent ?? null,
				tokens: usage?.tokens ?? null,
				timestamp: Date.now(),
			},
		});

		return {
			messages: [...event.messages, customMessage(buildThresholdAdvisory(threshold, usage), { threshold, usage })],
		};
	});

	pi.on("session_before_compact", (event) => {
		const pending = pendingCompaction;
		if (!pending) return;
		return {
			compaction: {
				summary: pending.summary,
				firstKeptEntryId: `${FULL_REPLACEMENT_SENTINEL}:${pending.requestId}`,
				tokensBefore: event.preparation.tokensBefore,
				details: {
					source: ENTRY_TYPE,
					requestId: pending.requestId,
					threshold: pending.threshold,
					summaryChars: pending.summary.length,
					fullReplacement: true,
				},
			},
		};
	});

	pi.on("session_compact", (event, ctx) => {
		const pending = pendingCompaction;
		if (!pending || pending.started) return;
		const details = event.compactionEntry.details as { requestId?: string; source?: string } | undefined;
		if (details?.source !== ENTRY_TYPE || details.requestId !== pending.requestId) return;
		completePendingCompaction(pi, ctx, event.compactionEntry.tokensBefore);
	});

	pi.on("agent_end", (_event, ctx) => {
		runPendingCompactionAfterAgent(pi, ctx);
	});

	pi.on("session_shutdown", () => {
		pendingCompaction = null;
		clearScheduledMessage();
	});
}
