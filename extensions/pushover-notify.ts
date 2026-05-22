import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const PUSHOVER_API_URL = "https://api.pushover.net/1/messages.json";
const DEFAULT_TITLE = "Pi finished";
const DEFAULT_MESSAGE = "Ready for your next prompt";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_DEBOUNCE_MS = 3000;
const CMUX_TIMEOUT_MS = 3000;
const PUSHOVER_TITLE_MAX_LENGTH = 250;

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

export default function pushoverNotify(pi: ExtensionAPI): void {
	let startedAt = Date.now();
	let warnedMissingConfig = false;
	let lastNotificationKey = "";
	let lastNotificationAt = 0;

	pi.on("session_start", async (_event, ctx) => {
		if (!isConfigured(readConfig()) && !warnedMissingConfig) {
			warnedMissingConfig = true;
			showConfigurationWarning(ctx);
		}
	});

	pi.on("agent_start", async () => {
		startedAt = Date.now();
	});

	pi.on("agent_end", async (event, ctx) => {
		const config = readConfig();
		if (!isConfigured(config)) return;

		const durationMs = Date.now() - startedAt;
		if (durationMs < config.minDurationMs) return;

		const completion = completionMessage(event.messages, durationMs);
		if (!completion) return;

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
	});

	pi.registerCommand("pushover-test", {
		description: "Send a test Pushover notification",
		handler: async (_args, ctx) => {
			const config = readConfig();
			try {
				await sendPushover(config, config.title, "Test notification from Pi");
				ctx.ui.notify("Sent Pushover test notification", "info");
			} catch (error) {
				reportFailure(ctx, error);
			}
		},
	});
}
