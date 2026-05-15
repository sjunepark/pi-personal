import type { GoalState, GoalStatus } from "./types.js";
import { MAX_OBJECTIVE_CHARS } from "./types.js";

export type ParsedGoalArgs = {
	objective: string;
	tokenBudget: number | null;
	error?: string;
};

export function parseCount(raw: string): number | null {
	const match = raw.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)([kmb])?$/);
	if (!match) return null;
	const value = Number(match[1]);
	const suffix = match[2];
	const multiplier = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : suffix === "b" ? 1_000_000_000 : 1;
	const parsed = Math.floor(value * multiplier);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parseGoalArgs(args: string): ParsedGoalArgs {
	let remaining = args.trimStart();
	let tokenBudget: number | null = null;

	while (true) {
		const inline = remaining.match(/^--(?:tokens|token-budget|budget)=(\S+)/);
		if (inline) {
			const parsed = parseCount(inline[1]);
			if (parsed === null) return { objective: "", tokenBudget: null, error: `Invalid token budget: ${inline[1]}` };
			tokenBudget = parsed;
			remaining = remaining.slice(inline[0].length).trimStart();
			continue;
		}

		const separate = remaining.match(/^(--(?:tokens|token-budget|budget))(?:\s+)(\S+)/);
		if (separate) {
			const parsed = parseCount(separate[2]);
			if (parsed === null) return { objective: "", tokenBudget: null, error: `Invalid token budget: ${separate[2]}` };
			tokenBudget = parsed;
			remaining = remaining.slice(separate[0].length).trimStart();
			continue;
		}

		const missingValue = remaining.match(/^(--(?:tokens|token-budget|budget))(?:\s*$|=\s*$)/);
		if (missingValue) return { objective: "", tokenBudget: null, error: `${missingValue[1]} requires a value.` };

		break;
	}

	const objective = remaining.trim();
	if (!objective) return { objective, tokenBudget, error: "Usage: /goal [--tokens 50k] <objective>" };
	if ([...objective].length > MAX_OBJECTIVE_CHARS) return { objective, tokenBudget, error: `Objective must be ${MAX_OBJECTIVE_CHARS} characters or fewer.` };
	return { objective, tokenBudget };
}

export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}m`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k`;
	return String(tokens);
}

export function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remSeconds = seconds % 60;
	if (minutes < 60) return remSeconds ? `${minutes}m${remSeconds}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remMinutes = minutes % 60;
	return remMinutes ? `${hours}h${remMinutes}m` : `${hours}h`;
}

export function truncate(text: string, max = 96): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	return singleLine.length <= max ? singleLine : `${singleLine.slice(0, max - 1)}…`;
}

export function statusLabel(status: GoalStatus): string {
	switch (status) {
		case "active":
			return "active";
		case "paused":
			return "paused";
		case "budget_limited":
			return "budget limited";
		case "complete":
			return "complete";
	}
}

export function statusLine(state: GoalState | null): string | undefined {
	if (!state) return undefined;
	const parts = [`goal ${statusLabel(state.status)}`];
	if (state.tokenBudget !== null) parts.push(`${formatTokens(state.tokensUsed)}/${formatTokens(state.tokenBudget)}`);
	else if (state.tokensUsed > 0) parts.push(formatTokens(state.tokensUsed));
	return parts.join(" · ");
}

export function goalSummary(state: GoalState | null): string {
	if (!state) return "No goal is set. Use `/goal <objective>` to start one.";
	const lines = [
		`Goal: ${statusLabel(state.status)}`,
		`Objective: ${state.objective}`,
		`Time: ${formatDuration(state.timeUsedSeconds)}`,
		`Tokens used: ${formatTokens(state.tokensUsed)}`,
	];
	if (state.tokenBudget !== null) {
		lines.push(`Token budget: ${formatTokens(state.tokenBudget)}`);
		lines.push(`Tokens remaining: ${formatTokens(Math.max(0, state.tokenBudget - state.tokensUsed))}`);
	}
	lines.push("Controls: /goal pause, /goal resume, /goal clear, /goal statusbar on|off");
	return lines.join("\n");
}
