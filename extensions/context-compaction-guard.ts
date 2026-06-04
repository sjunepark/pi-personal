import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { agentCompaction } from "./agent-compaction.js";

type ContextUsage = ReturnType<ExtensionContext["getContextUsage"]>;

type GuardState = {
	alertedThresholds?: number[];
	lastAlert?: {
		threshold: number;
		percent: number | null;
		tokens: number | null;
		timestamp: number;
	};
};

const ENTRY_TYPE = "context-compaction-guard-state";
const MESSAGE_TYPE = "context-compaction-guard";
const THRESHOLDS = [40, 50, 60, 70] as const;
const URGENT_THRESHOLD = 70;

let alertedThresholds = new Set<number>();

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

export default function contextCompactionGuard(pi: ExtensionAPI): void {
	agentCompaction.register(pi);

	pi.on("session_start", (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("context", (event, ctx) => {
		if (agentCompaction.busy) return;
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
}
