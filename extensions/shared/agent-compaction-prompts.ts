type ContextUsageLike = {
	percent: number | null;
	tokens: number | null;
	contextWindow: number;
} | undefined;

export const DEFAULT_AGENT_COMPACTION_SECTIONS = [
	"## Current task",
	"## User constraints and preferences",
	"## Current state / progress",
	"## Key decisions and rationale",
	"## Files and code already inspected\n- Include exact paths.\n- For important files, include relevant content, snippets, APIs, invariants, and conclusions.\n- For small central files, include full content when that prevents rereading.\n- Do not merely list paths if the file contents are likely needed after compaction.",
	"## Files modified / pending edits",
	"## Commands and validation results",
	"## Errors, blockers, and open questions",
	"## Next actions",
] as const;

export function formatContextUsage(usage: ContextUsageLike): string {
	if (!usage) return "context usage unavailable";
	const percent = usage.percent === null ? "unknown" : `${usage.percent.toFixed(1)}%`;
	const tokens = usage.tokens === null ? "unknown tokens" : `${usage.tokens.toLocaleString()} tokens`;
	return `${percent} (${tokens} / ${usage.contextWindow.toLocaleString()})`;
}

export function agentCompactionSummaryChecklist(sections: readonly string[] = DEFAULT_AGENT_COMPACTION_SECTIONS): string {
	return sections.join("\n");
}

export function buildAgentCompactionRequestMessage(options: {
	title: string;
	opening: string;
	required: boolean;
	why: readonly string[];
	customInstructions?: string;
	afterCompaction?: string;
	failureInstruction?: string;
	sections?: readonly string[];
}): string {
	const requirement = options.required
		? "Before continuing, call compact_conversation with a high-fidelity compacted working context, then stop this turn."
		: "Decide automatically whether to compact before continuing. If you choose to compact, call compact_conversation with a high-fidelity compacted working context.";
	const customInstructions = options.customInstructions
		? `\n\nUser-provided compaction focus:\n${options.customInstructions}`
		: "";
	const afterCompaction = options.afterCompaction ? `\n- After compaction: ${options.afterCompaction}` : "";
	const failureInstruction = options.failureInstruction ? `\n\n${options.failureInstruction}` : "";

	return `${options.title}

${options.opening}

This is an agent-facing context-engineering checkpoint, not a request for the human user. ${requirement}

Why this option exists:
${options.why.map((item) => `- ${item}`).join("\n")}${customInstructions}

Your compact_conversation summary should preserve:
${agentCompactionSummaryChecklist(options.sections)}${afterCompaction}

The summary may be long. It is for an LLM, not for a human skim.${failureInstruction}`;
}

export function buildThresholdCompactionAdvisory(options: {
	threshold: number;
	usageLabel: string;
	urgent: boolean;
}): string {
	return `${buildAgentCompactionRequestMessage({
		title: `Context compaction checkpoint: current context usage crossed ${options.threshold}% (${options.usageLabel}).`,
		opening: options.urgent
			? "Urgency: HIGH. Strongly consider compacting now unless the task is about to finish or you cannot produce a high-fidelity compacted context yet."
			: "Urgency: moderate. Compact only if you can preserve the details needed to continue without avoidable rereads.",
		required: false,
		why: [
			"Agents often lose focus as context grows; degradation is commonly noticeable around or after ~70% usage.",
			"Good context engineering keeps the smallest high-signal working context, not every historical token.",
			"Even before 70%, replacing low-value history with a dense working context can improve long-run output quality.",
			"Compaction should not be overused: weak compaction can cause repeated reads of files already inspected, wasting time and filling context again.",
		],
	})}

If you choose not to compact, silently continue the user's task. Do not ask the human for confirmation.`;
}

export function buildManualCompactionRequestMessage(options: {
	usage?: ContextUsageLike;
	customInstructions?: string;
}): string {
	return buildAgentCompactionRequestMessage({
		title: `Manual agent-authored context compaction requested (${formatContextUsage(options.usage)}).`,
		opening: "The human user invoked /compact-custom to replace the current conversation history with a dense working context.",
		required: true,
		why: [
			"The user explicitly requested a custom agent-authored compaction rather than pi's generic /compact summary.",
			"A high-fidelity summary should preserve exact task state, inspected files, important snippets, validation, and next actions.",
			"This compaction should reduce context while avoiding unnecessary rereads after the replacement.",
		],
		customInstructions: options.customInstructions,
		afterCompaction: "stop. Do not continue the user's task, run tools, or report further until the human sends another message.",
		failureInstruction: "Do not inspect new files or start unrelated work before compacting. If you cannot produce a high-fidelity summary, explain the blocker instead of calling compact_conversation with a weak summary.",
	});
}
