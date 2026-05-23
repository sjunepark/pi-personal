import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const PUSHOVER_API_URL = "https://api.pushover.net/1/messages.json";
const DEFAULT_TITLE = "Pi finished";
const DEFAULT_MESSAGE = "Ready for your next prompt";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_DEBOUNCE_MS = 3000;
const CMUX_TIMEOUT_MS = 3000;
const PUSHOVER_TITLE_MAX_LENGTH = 250;
const STATE_FILE_ENV = "PI_PUSHOVER_STATE_FILE";

type PushoverConfig = {
	token?: string;
	user?: string;
	device?: string;
	sound?: string;
	title: string;
	minDurationMs: number;
	debounceMs: number;
	timeoutMs: number;
};

type AssistantLike = {
	role?: string;
	stopReason?: string;
};

type CompletionNotification = {
	title: string;
	message: string;
};

type PostReviewLoopState = {
	id?: string;
	lifecycle?: string;
	createdAt?: number;
	phase?: string;
	iteration?: number;
	limit?: number;
};

type PostReviewLoopEntry = {
	type?: string;
	customType?: string;
	data?: {
		event?: string;
		state?: unknown;
	};
};

const POST_REVIEW_LOOP_ENTRY_TYPE = "post-review-loop-state";

function stateFilePath(): string {
	return firstNonEmpty(process.env[STATE_FILE_ENV]) ?? join(homedir(), ".pi", "agent", "pushover-notify-state.json");
}

function readStoredEnabled(): boolean | undefined {
	const path = stateFilePath();
	if (!existsSync(path)) return undefined;

	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isRecord(parsed) && typeof parsed.enabled === "boolean" ? parsed.enabled : undefined;
	} catch {
		return undefined;
	}
}

function notificationsEnabled(): boolean {
	return readStoredEnabled() !== false;
}

function writeNotificationsEnabled(enabled: boolean): void {
	const path = stateFilePath();
	const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(tempPath, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
	renameSync(tempPath, path);
}

function readConfig(): PushoverConfig {
	return {
		token: firstNonEmpty(process.env.PUSHOVER_APP_TOKEN, process.env.PUSHOVER_API_TOKEN),
		user: firstNonEmpty(process.env.PUSHOVER_USER_KEY),
		device: firstNonEmpty(process.env.PUSHOVER_DEVICE),
		sound: firstNonEmpty(process.env.PUSHOVER_SOUND),
		title: firstNonEmpty(process.env.PI_PUSHOVER_TITLE) || DEFAULT_TITLE,
		minDurationMs: parseNonNegativeInt(process.env.PI_PUSHOVER_MIN_MS, 0),
		debounceMs: parseNonNegativeInt(process.env.PI_PUSHOVER_DEBOUNCE_MS, DEFAULT_DEBOUNCE_MS),
		timeoutMs: parsePositiveInt(process.env.PI_PUSHOVER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
	};
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isConfigured(config: PushoverConfig): boolean {
	return Boolean(config.token && config.user);
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(1, Math.round(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes === 0) return `${totalSeconds}s`;
	if (seconds === 0) return `${minutes}m`;
	return `${minutes}m ${seconds}s`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object");
}

function isPostReviewLoopState(value: unknown): value is PostReviewLoopState {
	return isRecord(value) && value.version === 1 && typeof value.id === "string" && typeof value.lifecycle === "string";
}

function latestPostReviewLoopState(ctx: ExtensionContext): PostReviewLoopState | null {
	const manager = ctx.sessionManager as { getBranch?: () => unknown[]; getEntries?: () => unknown[] };
	const entries = manager.getBranch?.() ?? manager.getEntries?.() ?? [];
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as PostReviewLoopEntry;
		if (entry.type !== "custom" || entry.customType !== POST_REVIEW_LOOP_ENTRY_TYPE) continue;
		if (entry.data?.event === "cleared") return null;
		if (isPostReviewLoopState(entry.data?.state)) return entry.data.state;
	}
	return null;
}

function postReviewLoopId(state: PostReviewLoopState | null): string | undefined {
	return firstNonEmpty(state?.id);
}

function isPostReviewLoopTerminal(state: PostReviewLoopState): boolean {
	return state.lifecycle === "complete" || state.lifecycle === "failed";
}

function loopDurationMs(state: PostReviewLoopState, fallbackMs: number): number {
	return typeof state.createdAt === "number" && Number.isFinite(state.createdAt) && state.createdAt > 0 ? Math.max(0, Date.now() - state.createdAt) : fallbackMs;
}

function parseCmuxWorkspaceName(treeOutput: string): string | undefined {
	const match = treeOutput.match(/^.*\bworkspace\s+workspace:\d+\s+"([^"]+)".*$/m);
	return match?.[1]?.trim() || undefined;
}

async function getCmuxWorkspaceName(pi: ExtensionAPI): Promise<string | undefined> {
	const workspaceId = firstNonEmpty(process.env.CMUX_WORKSPACE_ID);
	if (!workspaceId) return undefined;

	const result = await pi.exec("cmux", ["tree", "--workspace", workspaceId], { timeout: CMUX_TIMEOUT_MS });
	if (result.killed || result.code !== 0) return undefined;
	return parseCmuxWorkspaceName(result.stdout);
}

function formatTitle(baseTitle: string, workspaceName?: string): string {
	return trimSummary(workspaceName ? `${baseTitle} · ${workspaceName}` : baseTitle, PUSHOVER_TITLE_MAX_LENGTH);
}

function getLastAssistantMessage(messages: readonly unknown[]): AssistantLike | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as AssistantLike;
		if (message?.role === "assistant") return message;
	}
	return undefined;
}

function trimSummary(text: string, maxLength = 160): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 3)}...` : collapsed;
}

function completionMessage(messages: readonly unknown[], durationMs: number): CompletionNotification | undefined {
	const assistant = getLastAssistantMessage(messages);
	if (assistant?.stopReason === "error" || assistant?.stopReason === "aborted") {
		return undefined;
	}

	const duration = formatDuration(durationMs);
	return {
		title: DEFAULT_TITLE,
		message: durationMs >= 1000 ? `${DEFAULT_MESSAGE} (took ${duration})` : DEFAULT_MESSAGE,
	};
}

function postReviewLoopCompletionMessage(state: PostReviewLoopState, durationMs: number): CompletionNotification {
	const status = state.lifecycle === "failed" ? "failed" : "completed";
	const progress = typeof state.iteration === "number" && typeof state.limit === "number" ? ` after ${state.iteration}/${state.limit}` : "";
	return {
		title: DEFAULT_TITLE,
		message: `Post-review-loop ${status}${progress} (took ${formatDuration(durationMs)})`,
	};
}

async function sendPushover(config: PushoverConfig, title: string, message: string): Promise<void> {
	if (!config.token || !config.user) {
		throw new Error("Pushover is not configured. Set PUSHOVER_APP_TOKEN and PUSHOVER_USER_KEY.");
	}

	const body = new URLSearchParams({
		token: config.token,
		user: config.user,
		title,
		message,
	});
	if (config.device) body.set("device", config.device);
	if (config.sound) body.set("sound", config.sound);

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
	try {
		const response = await fetch(PUSHOVER_API_URL, {
			method: "POST",
			body,
			signal: controller.signal,
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new Error(`Pushover request failed (${response.status})${detail ? `: ${trimSummary(detail)}` : ""}`);
		}
	} finally {
		clearTimeout(timeout);
	}
}

function reportFailure(ctx: ExtensionContext, error: unknown): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(error instanceof Error ? error.message : "Pushover notification failed", "warning");
}

function showConfigurationWarning(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify("Pushover notifications disabled: set PUSHOVER_APP_TOKEN and PUSHOVER_USER_KEY", "warning");
}

function updatePushoverStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	if (notificationsEnabled()) {
		ctx.ui.setStatus("pushover", undefined);
		return;
	}
	ctx.ui.setStatus("pushover", ctx.ui.theme.fg("warning", "pushover:off"));
}

function displayStateFilePath(): string {
	const home = homedir();
	const path = stateFilePath();
	return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function pushoverStatusMessage(): string {
	const enabled = notificationsEnabled();
	const configured = isConfigured(readConfig());
	return `Pushover notifications: ${enabled ? "on" : "off"}; ${configured ? "configured" : "missing PUSHOVER_APP_TOKEN/PUSHOVER_USER_KEY"}; state: ${displayStateFilePath()}.`;
}

export default function pushoverNotify(pi: ExtensionAPI): void {
	let startedAt = Date.now();
	let warnedMissingConfig = false;
	let lastNotificationKey = "";
	let lastNotificationAt = 0;
	let currentPostReviewLoopId: string | undefined;
	const observedActivePostReviewLoopIds = new Set<string>();
	const notifiedPostReviewLoopIds = new Set<string>();

	async function sendCompletion(ctx: ExtensionContext, config: PushoverConfig, completion: CompletionNotification): Promise<void> {
		if (!notificationsEnabled()) return;

		const baseTitle = completion.title === DEFAULT_TITLE ? config.title : completion.title;
		const title = formatTitle(baseTitle, await getCmuxWorkspaceName(pi));
		const notificationKey = `${title}\n${completion.message}`;
		const now = Date.now();
		if (notificationKey === lastNotificationKey && now - lastNotificationAt < config.debounceMs) return;

		lastNotificationKey = notificationKey;
		lastNotificationAt = now;
		void sendPushover(config, title, completion.message).catch((error) => {
			reportFailure(ctx, error);
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		updatePushoverStatus(ctx);
		if (notificationsEnabled() && !isConfigured(readConfig()) && !warnedMissingConfig) {
			warnedMissingConfig = true;
			showConfigurationWarning(ctx);
		}

		const state = latestPostReviewLoopState(ctx);
		const id = postReviewLoopId(state);
		if (!state || !id) return;
		if (isPostReviewLoopTerminal(state)) {
			notifiedPostReviewLoopIds.add(id);
		} else {
			observedActivePostReviewLoopIds.add(id);
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		startedAt = Date.now();
		const state = latestPostReviewLoopState(ctx);
		const id = postReviewLoopId(state);
		currentPostReviewLoopId = state && id && !isPostReviewLoopTerminal(state) ? id : undefined;
		if (currentPostReviewLoopId) observedActivePostReviewLoopIds.add(currentPostReviewLoopId);
	});

	pi.on("agent_end", async (event, ctx) => {
		const startedLoopId = currentPostReviewLoopId;
		currentPostReviewLoopId = undefined;

		const loopState = latestPostReviewLoopState(ctx);
		const loopId = postReviewLoopId(loopState);
		if (loopState && loopId && !isPostReviewLoopTerminal(loopState)) {
			observedActivePostReviewLoopIds.add(loopId);
			return;
		}

		if (!notificationsEnabled()) return;

		const config = readConfig();
		if (!isConfigured(config)) return;

		const durationMs = Date.now() - startedAt;
		const loopCompletedDuringThisAgent = Boolean(
			loopState && loopId && isPostReviewLoopTerminal(loopState) && (startedLoopId === loopId || observedActivePostReviewLoopIds.has(loopId)),
		);
		if (loopCompletedDuringThisAgent && loopState && loopId && !notifiedPostReviewLoopIds.has(loopId)) {
			notifiedPostReviewLoopIds.add(loopId);
			const loopDuration = loopDurationMs(loopState, durationMs);
			if (loopDuration < config.minDurationMs) return;
			await sendCompletion(ctx, config, postReviewLoopCompletionMessage(loopState, loopDuration));
			return;
		}
		if (startedLoopId) return;

		if (durationMs < config.minDurationMs) return;

		const completion = completionMessage(event.messages, durationMs);
		if (!completion) return;

		await sendCompletion(ctx, config, completion);
	});

	function setPushoverEnabled(enabled: boolean, ctx: ExtensionContext): void {
		writeNotificationsEnabled(enabled);
		updatePushoverStatus(ctx);
		ctx.ui.notify(`Pushover completion notifications ${enabled ? "enabled" : "disabled"}`, "info");
	}

	async function sendTestNotification(ctx: ExtensionContext): Promise<void> {
		const config = readConfig();
		try {
			await sendPushover(config, config.title, "Test notification from Pi");
			ctx.ui.notify("Sent Pushover test notification", "info");
		} catch (error) {
			reportFailure(ctx, error);
		}
	}

	pi.registerCommand("pushover", {
		description: "Manage Pushover notifications: on, off, status, test",
		handler: async (args, ctx) => {
			const action = (args ?? "").trim().toLowerCase();
			try {
				if (action === "on") {
					setPushoverEnabled(true, ctx);
					return;
				}
				if (action === "off") {
					setPushoverEnabled(false, ctx);
					return;
				}
				if (action === "" || action === "status") {
					updatePushoverStatus(ctx);
					ctx.ui.notify(pushoverStatusMessage(), "info");
					return;
				}
				if (action === "test") {
					await sendTestNotification(ctx);
					return;
				}
				ctx.ui.notify("Usage: /pushover on|off|status|test", "warning");
			} catch (error) {
				reportFailure(ctx, error);
			}
		},
	});

	pi.registerCommand("pushover-on", {
		description: "Enable automatic Pushover completion notifications",
		handler: async (_args, ctx) => {
			try {
				setPushoverEnabled(true, ctx);
			} catch (error) {
				reportFailure(ctx, error);
			}
		},
	});

	pi.registerCommand("pushover-off", {
		description: "Disable automatic Pushover completion notifications",
		handler: async (_args, ctx) => {
			try {
				setPushoverEnabled(false, ctx);
			} catch (error) {
				reportFailure(ctx, error);
			}
		},
	});

	pi.registerCommand("pushover-status", {
		description: "Show Pushover notification status",
		handler: async (_args, ctx) => {
			updatePushoverStatus(ctx);
			ctx.ui.notify(pushoverStatusMessage(), "info");
		},
	});

	pi.registerCommand("pushover-test", {
		description: "Send a test Pushover notification",
		handler: async (_args, ctx) => {
			await sendTestNotification(ctx);
		},
	});
}
