import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isReadToolResult,
	isWriteToolResult,
	type ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
import { basename, resolve } from "node:path";

const STATUS_KEY = "pi";
const CMUX_TIMEOUT_MS = 3000;
const DEFAULT_NOTIFY_TITLE = "Pi";
const DEFAULT_NOTIFY_LEVEL = "all";
const DEFAULT_COMPLETE_THRESHOLD_MS = 15000;
const DEFAULT_DEBOUNCE_MS = 3000;
const DEFAULT_INPUT_GRACE_MS = 500;
const DEFAULT_BASH_INPUT_GRACE_MS = 1500;
const ATTENTION_REFRESH_MS = 1000;

const STATUS_PRIORITY_IDLE = 0;
const STATUS_PRIORITY_WORKING = 1;
const STATUS_PRIORITY_ATTENTION = 2;
const STATUS_PRIORITY_ERROR = 3;

type NotifyLevel = "all" | "medium" | "low" | "disabled";

type RunState = {
	startedAt: number;
	readFiles: Set<string>;
	changedFiles: Set<string>;
	searchCount: number;
	bashCount: number;
	firstToolError?: string;
};

type AssistantLike = {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
	content?: Array<{ type?: string; text?: string }>;
};

type StatusState = {
	value: string;
	color: string;
	icon?: string;
	priority: number;
};

type AttentionProbe = {
	body: string;
	graceMs: number;
};

function notifyOsc777(title: string, body: string) {
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function createRunState(): RunState {
	return {
		startedAt: Date.now(),
		readFiles: new Set<string>(),
		changedFiles: new Set<string>(),
		searchCount: 0,
		bashCount: 0,
	};
}

function getNumberFromEnv(name: string, fallback: number): number {
	const value = process.env[name];
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function getNotifyLevelFromEnv(): NotifyLevel {
	const value = process.env.PI_CMUX_NOTIFY_LEVEL?.trim().toLowerCase();
	if (value === "all" || value === "medium" || value === "low" || value === "disabled") {
		return value;
	}
	return DEFAULT_NOTIFY_LEVEL;
}

function trimSummary(text: string, maxLength = 140): string {
	return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(1, Math.round(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes === 0) return `${totalSeconds}s`;
	if (seconds === 0) return `${minutes}m`;
	return `${minutes}m ${seconds}s`;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
	return count === 1 ? singular : plural;
}

function describeFiles(prefix: string, files: Set<string>): string | undefined {
	const names = [...files].map((file) => basename(file));
	if (names.length === 0) return undefined;
	if (names.length === 1) return `${prefix} ${names[0]}`;
	if (names.length === 2) return `${prefix} ${names[0]} and ${names[1]}`;
	if (names.length === 3) return `${prefix} ${names[0]}, ${names[1]}, and ${names[2]}`;
	return `${prefix} ${names.length} ${pluralize(names.length, "file")}`;
}

function getPath(event: ToolResultEvent): string | undefined {
	return typeof event.input.path === "string" && event.input.path.length > 0 ? event.input.path : undefined;
}

function getFirstText(event: ToolResultEvent): string | undefined {
	const textPart = event.content.find((part) => part.type === "text");
	if (!textPart || textPart.type !== "text") return undefined;
	const text = textPart.text.trim();
	return text.length > 0 ? text : undefined;
}

function summarizeToolError(event: ToolResultEvent): string {
	const path = getPath(event);
	if (path) return trimSummary(`${event.toolName} failed for ${basename(path)}`);
	if (isBashToolResult(event)) return "bash command failed";
	return trimSummary(getFirstText(event) || `${event.toolName} failed`);
}

function isInsidePath(root: string, target: string): boolean {
	const resolvedRoot = resolve(root);
	const resolvedTarget = resolve(target);
	return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}/`);
}

function getCurrentPhaseState(toolName?: string): StatusState {
	if (!toolName) {
		return { value: "Thinking", color: "#4C8DFF", icon: "bolt.fill", priority: STATUS_PRIORITY_WORKING };
	}
	return {
		value: currentPhaseLabel(toolName),
		color: "#4C8DFF",
		icon: "hammer",
		priority: STATUS_PRIORITY_WORKING,
	};
}

function getPathAttentionProbe(pathLabel: string, path: unknown, cwd: string): AttentionProbe | undefined {
	if (typeof path !== "string" || path.length === 0) {
		return { body: `Confirm ${pathLabel}`, graceMs: DEFAULT_INPUT_GRACE_MS };
	}
	const targetPath = resolve(cwd, path.replace(/^@/, ""));
	if (isInsidePath(cwd, targetPath) || isInsidePath("/tmp", targetPath)) {
		return undefined;
	}
	return {
		body: `Confirm ${pathLabel} ${basename(targetPath)}`,
		graceMs: DEFAULT_INPUT_GRACE_MS,
	};
}

function isLikelyPromptedBash(command: string): boolean {
	return [
		/\bsudo\b/i,
		/\brm\s+(-rf?|--recursive)/i,
		/\b(chmod|chown)\b/i,
		/\b(curl|wget)\b/i,
		/\b(npm|pnpm|bun|yarn)\b.*\b(install|add|update|publish)\b/i,
		/\b(git\s+(push|fetch|pull|clone))\b/i,
	].some((pattern) => pattern.test(command));
}

function getAttentionProbe(toolName: string, input: Record<string, unknown>, cwd: string): AttentionProbe | undefined {
	if (toolName === "write") return getPathAttentionProbe("write to", input.path, cwd);
	if (toolName === "edit") return getPathAttentionProbe("edit", input.path, cwd);
	if (toolName === "read") return getPathAttentionProbe("read", input.path, cwd);
	if (toolName !== "bash") return undefined;
	if (typeof input.command !== "string" || input.command.trim().length === 0) {
		return { body: "Confirm shell command", graceMs: DEFAULT_BASH_INPUT_GRACE_MS };
	}
	if (!isLikelyPromptedBash(input.command)) return undefined;
	return {
		body: trimSummary(`Confirm shell command: ${input.command.trim()}`, 120),
		graceMs: DEFAULT_BASH_INPUT_GRACE_MS,
	};
}

function summarizeSuccess(state: RunState, durationMs: number, completeThresholdMs: number): string {
	const changedSummary = describeFiles("Updated", state.changedFiles);
	if (changedSummary) {
		return durationMs >= completeThresholdMs ? `${changedSummary} in ${formatDuration(durationMs)}` : changedSummary;
	}

	const readSummary = describeFiles("Reviewed", state.readFiles);
	if (readSummary) {
		return durationMs >= completeThresholdMs ? `${readSummary} in ${formatDuration(durationMs)}` : readSummary;
	}

	if (state.searchCount > 0 && state.bashCount > 0) {
		const summary = `Ran ${state.searchCount} ${pluralize(state.searchCount, "search")} and ${state.bashCount} ${pluralize(state.bashCount, "shell command")}`;
		return durationMs >= completeThresholdMs ? `${summary} in ${formatDuration(durationMs)}` : summary;
	}
	if (state.searchCount > 0) {
		const summary = state.searchCount === 1 ? "Searched the codebase" : `Ran ${state.searchCount} searches`;
		return durationMs >= completeThresholdMs ? `${summary} in ${formatDuration(durationMs)}` : summary;
	}
	if (state.bashCount > 0) {
		const summary = `Ran ${state.bashCount} ${pluralize(state.bashCount, "shell command")}`;
		return durationMs >= completeThresholdMs ? `${summary} in ${formatDuration(durationMs)}` : summary;
	}
	if (durationMs >= completeThresholdMs) {
		return `Finished in ${formatDuration(durationMs)}`;
	}
	return "Ready for input";
}

function getLastAssistantMessage(messages: readonly unknown[]): AssistantLike | undefined {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i] as AssistantLike;
		if (message?.role === "assistant") return message;
	}
	return undefined;
}

function summarizeAssistantText(message: AssistantLike): string | undefined {
	if (!Array.isArray(message.content)) return undefined;
	const text = message.content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text.trim())
		.filter(Boolean)
		.join("\n")
		.trim();
	return text ? trimSummary(text) : undefined;
}

function summarizeRunOutcome(
	messages: readonly unknown[],
	fallback?: string,
): { kind: "error" | "aborted"; message: string } | undefined {
	const assistant = getLastAssistantMessage(messages);
	if (!assistant) {
		return fallback ? { kind: "error", message: fallback } : undefined;
	}
	if (assistant.stopReason === "error") {
		return {
			kind: "error",
			message: trimSummary(assistant.errorMessage?.trim() || summarizeAssistantText(assistant) || fallback || "Agent run failed"),
		};
	}
	if (assistant.stopReason === "aborted") {
		return {
			kind: "aborted",
			message: trimSummary(assistant.errorMessage?.trim() || summarizeAssistantText(assistant) || "Operation aborted"),
		};
	}
	return undefined;
}

function currentPhaseLabel(toolName?: string): string {
	if (!toolName) return "Thinking";
	if (toolName === "read") return "Reading";
	if (toolName === "edit") return "Editing";
	if (toolName === "write") return "Writing";
	if (toolName === "bash") return "Shell";
	if (toolName === "grep" || toolName === "find") return "Searching";
	return toolName;
}

function isInsideCmux(): boolean {
	return Boolean(process.env.CMUX_WORKSPACE_ID);
}

function shouldNotify(level: NotifyLevel, subtitle: string): boolean {
	if (level === "disabled") return false;
	if (level === "all") return true;
	if (level === "medium") return subtitle === "Task Complete" || subtitle === "Error" || subtitle === "Needs Input";
	if (level === "low") return subtitle === "Error" || subtitle === "Needs Input";
	return true;
}

export default function (pi: ExtensionAPI) {
	const notifyTitle = process.env.PI_CMUX_NOTIFY_TITLE || DEFAULT_NOTIFY_TITLE;
	const notifyLevel = getNotifyLevelFromEnv();
	const completeThresholdMs = getNumberFromEnv("PI_CMUX_NOTIFY_THRESHOLD_MS", DEFAULT_COMPLETE_THRESHOLD_MS);
	const debounceMs = getNumberFromEnv("PI_CMUX_NOTIFY_DEBOUNCE_MS", DEFAULT_DEBOUNCE_MS);
	const inputGraceMs = getNumberFromEnv("PI_CMUX_NOTIFY_INPUT_GRACE_MS", DEFAULT_INPUT_GRACE_MS);
	const bashInputGraceMs = getNumberFromEnv("PI_CMUX_NOTIFY_BASH_INPUT_GRACE_MS", DEFAULT_BASH_INPUT_GRACE_MS);

	let runState = createRunState();
	let cmuxUnavailable = false;
	let lastNotificationKey = "";
	let lastNotificationAt = 0;
	let currentStatusPriority = STATUS_PRIORITY_IDLE;
	let currentPhaseState = getCurrentPhaseState();
	let pendingAttentionTimers = new Map<string, NodeJS.Timeout>();
	let activeAttention = new Map<string, string>();
	let attentionRefreshTimer: NodeJS.Timeout | undefined;

	async function execCmux(args: string[]): Promise<boolean> {
		if (!isInsideCmux() || cmuxUnavailable) return false;

		const result = await pi.exec("cmux", args, { timeout: CMUX_TIMEOUT_MS });
		if (result.killed) return false;
		if (result.code !== 0) {
			const error = `${result.stderr}\n${result.stdout}`;
			if (error.includes("not found") || error.includes("ENOENT")) {
				cmuxUnavailable = true;
			}
			return false;
		}
		return true;
	}

	async function setStatus(value: string, color: string, icon?: string): Promise<void> {
		const args = ["set-status", STATUS_KEY, value, "--color", color];
		if (icon) args.push("--icon", icon);
		await execCmux(args);
	}

	async function clearStatus(): Promise<void> {
		await execCmux(["clear-status", STATUS_KEY]);
	}

	async function log(level: "info" | "progress" | "success" | "warning" | "error", message: string): Promise<void> {
		await execCmux(["log", "--level", level, "--source", "pi", message]);
	}

	async function notify(subtitle: string, body: string): Promise<void> {
		const notificationKey = `${subtitle}\n${body}`;
		const now = Date.now();
		if (notificationKey === lastNotificationKey && now - lastNotificationAt < debounceMs) {
			return;
		}

		const notified = await execCmux(["notify", "--title", notifyTitle, "--subtitle", subtitle, "--body", body]);
		if (!notified) {
			notifyOsc777(`${notifyTitle}: ${subtitle}`, body);
		}

		lastNotificationKey = notificationKey;
		lastNotificationAt = now;
	}

	async function applyStatus(state: StatusState, force = false): Promise<void> {
		if (!force && state.priority < currentStatusPriority) return;
		currentStatusPriority = state.priority;
		await setStatus(state.value, state.color, state.icon);
	}

	function clearAttentionTimer(toolCallId: string): void {
		const timer = pendingAttentionTimers.get(toolCallId);
		if (!timer) return;
		clearTimeout(timer);
		pendingAttentionTimers.delete(toolCallId);
	}

	function stopAttentionRefresh(): void {
		if (!attentionRefreshTimer) return;
		clearInterval(attentionRefreshTimer);
		attentionRefreshTimer = undefined;
	}

	function startAttentionRefresh(): void {
		if (attentionRefreshTimer) return;
		attentionRefreshTimer = setInterval(() => {
			if (activeAttention.size === 0) return;
			void applyStatus({ value: "Needs Input", color: "#FF9500", icon: "bell.fill", priority: STATUS_PRIORITY_ATTENTION }, true);
		}, ATTENTION_REFRESH_MS);
	}

	async function restorePhaseStatus(): Promise<void> {
		if (activeAttention.size > 0) return;
		currentStatusPriority = STATUS_PRIORITY_IDLE;
		await applyStatus(currentPhaseState);
	}

	async function clearAttention(toolCallId?: string): Promise<void> {
		if (toolCallId) {
			activeAttention.delete(toolCallId);
		} else {
			activeAttention.clear();
		}
		if (activeAttention.size === 0) {
			stopAttentionRefresh();
			if (currentStatusPriority === STATUS_PRIORITY_ATTENTION) {
				await restorePhaseStatus();
			}
		}
	}

	async function activateAttention(toolCallId: string, body: string): Promise<void> {
		if (activeAttention.has(toolCallId)) return;
		activeAttention.set(toolCallId, body);
		startAttentionRefresh();
		await applyStatus({ value: "Needs Input", color: "#FF9500", icon: "bell.fill", priority: STATUS_PRIORITY_ATTENTION }, true);
		if (shouldNotify(notifyLevel, "Needs Input")) {
			await notify("Needs Input", body);
		}
	}

	function resetAttentionState(): void {
		for (const timer of pendingAttentionTimers.values()) {
			clearTimeout(timer);
		}
		pendingAttentionTimers.clear();
		activeAttention.clear();
		stopAttentionRefresh();
	}

	pi.on("agent_start", async () => {
		runState = createRunState();
		resetAttentionState();
		currentPhaseState = getCurrentPhaseState();
		currentStatusPriority = STATUS_PRIORITY_IDLE;
		await applyStatus(currentPhaseState);
	});

	pi.on("turn_start", async () => {
		currentPhaseState = getCurrentPhaseState();
		await restorePhaseStatus();
	});

	pi.on("tool_execution_start", async (event) => {
		currentPhaseState = getCurrentPhaseState(event.toolName);
		await restorePhaseStatus();
	});

	pi.on("tool_call", async (event, ctx) => {
		const attentionProbe = getAttentionProbe(event.toolName, event.input as Record<string, unknown>, ctx.cwd);
		if (!attentionProbe) return;
		clearAttentionTimer(event.toolCallId);
		const graceMs =
			event.toolName === "bash"
				? bashInputGraceMs
				: attentionProbe.graceMs === DEFAULT_INPUT_GRACE_MS
					? inputGraceMs
					: attentionProbe.graceMs;
		const timer = setTimeout(() => {
			pendingAttentionTimers.delete(event.toolCallId);
			void activateAttention(event.toolCallId, attentionProbe.body);
		}, graceMs);
		pendingAttentionTimers.set(event.toolCallId, timer);
	});

	pi.on("tool_result", async (event) => {
		clearAttentionTimer(event.toolCallId);
		if (activeAttention.has(event.toolCallId)) {
			await clearAttention(event.toolCallId);
		}

		if (event.isError && !runState.firstToolError) {
			runState.firstToolError = summarizeToolError(event);
		}

		if (isReadToolResult(event)) {
			const path = getPath(event);
			if (path) runState.readFiles.add(path);
			return;
		}

		if ((isEditToolResult(event) || isWriteToolResult(event)) && !event.isError) {
			const path = getPath(event);
			if (path) runState.changedFiles.add(path);
			return;
		}

		if ((isGrepToolResult(event) || isFindToolResult(event)) && !event.isError) {
			runState.searchCount += 1;
			return;
		}

		if (isBashToolResult(event) && !event.isError) {
			runState.bashCount += 1;
		}
	});

	pi.on("agent_end", async (event) => {
		const durationMs = Date.now() - runState.startedAt;
		const runOutcome = summarizeRunOutcome(event.messages, runState.firstToolError);
		resetAttentionState();

		if (runOutcome?.kind === "error") {
			currentStatusPriority = STATUS_PRIORITY_IDLE;
			await applyStatus({ value: "Error", color: "#FF3B30", icon: "warning", priority: STATUS_PRIORITY_ERROR }, true);
			await log("error", runOutcome.message);
			if (shouldNotify(notifyLevel, "Error")) {
				await notify("Error", runOutcome.message);
			}
			return;
		}

		if (runOutcome?.kind === "aborted") {
			currentStatusPriority = STATUS_PRIORITY_IDLE;
			await applyStatus({ value: "Waiting", color: "#FF9500", icon: "bell.fill", priority: STATUS_PRIORITY_IDLE }, true);
			await log("warning", runOutcome.message);
			return;
		}

		const subtitle = durationMs >= completeThresholdMs || runState.changedFiles.size > 0 ? "Task Complete" : "Waiting";
		const body = summarizeSuccess(runState, durationMs, completeThresholdMs);
		currentStatusPriority = STATUS_PRIORITY_IDLE;
		await applyStatus({
			value: subtitle === "Waiting" ? "Waiting" : "Done",
			color: subtitle === "Waiting" ? "#FF9500" : "#34C759",
			icon: subtitle === "Waiting" ? "bell.fill" : "checkmark",
			priority: STATUS_PRIORITY_IDLE,
		}, true);
		await log("success", body);
		if (shouldNotify(notifyLevel, subtitle)) {
			await notify(subtitle, body);
		}
	});

	pi.on("session_shutdown", async () => {
		resetAttentionState();
		await clearStatus();
	});

	pi.registerCommand("notify-test", {
		description: "Send a test cmux notification",
		handler: async (_args, ctx) => {
			await setStatus("Testing", "#4C8DFF", "bolt.fill");
			await log("info", "Manual notification test");
			await notify("Test", "Manual notification from Pi");
			await setStatus("Waiting", "#FF9500", "bell.fill");
			ctx.ui.notify("Sent test cmux notification", "info");
		},
	});
}
