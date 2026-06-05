import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { agentCompaction } from "./agent-compaction.js";
import { buildThresholdCompactionAdvisory, formatContextUsage } from "./shared/agent-compaction-prompts.js";

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
			messages: [
				...event.messages,
				customMessage(
					buildThresholdCompactionAdvisory({
						threshold,
						usageLabel: formatContextUsage(usage),
						urgent: threshold >= URGENT_THRESHOLD,
					}),
					{ threshold, usage },
				),
			],
		};
	});
}
