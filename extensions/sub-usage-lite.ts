import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type SupportedProvider = "anthropic" | "openai-codex";

type CacheEntry = {
	fetchedAt: number;
	line: string | undefined;
};

type PiAuthFile = {
	anthropic?: {
		access?: string;
	};
	"openai-codex"?: {
		access?: string;
		accountId?: string;
	};
};

type AnthropicUsageResponse = {
	five_hour?: {
		utilization?: number;
		resets_at?: string;
	};
	seven_day?: {
		utilization?: number;
		resets_at?: string;
	};
};

type CodexRateWindow = {
	reset_at?: number;
	limit_window_seconds?: number;
	used_percent?: number;
};

type CodexUsageResponse = {
	rate_limit?: {
		primary_window?: CodexRateWindow;
		secondary_window?: CodexRateWindow;
	};
};

type LegacyCodexAuthFile = {
	tokens?: {
		access_token?: string;
		account_id?: string;
	};
};

const STATUS_KEY = "sub-usage-lite";
const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

function readJsonFile<T>(path: string): T | undefined {
	try {
		if (!existsSync(path)) return undefined;
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function getPiAuthFile(): PiAuthFile | undefined {
	return readJsonFile<PiAuthFile>(join(homedir(), ".pi", "agent", "auth.json"));
}

function loadAnthropicOauthToken(): string | undefined {
	const envToken = process.env.ANTHROPIC_OAUTH_TOKEN?.trim();
	if (envToken) return envToken;

	return getPiAuthFile()?.anthropic?.access?.trim() || undefined;
}

function loadCodexAuth(): { accessToken?: string; accountId?: string } {
	const envAccessToken = (
		process.env.OPENAI_CODEX_OAUTH_TOKEN ||
		process.env.OPENAI_CODEX_ACCESS_TOKEN ||
		process.env.CODEX_OAUTH_TOKEN ||
		process.env.CODEX_ACCESS_TOKEN
	)?.trim();
	const envAccountId = (process.env.OPENAI_CODEX_ACCOUNT_ID || process.env.CHATGPT_ACCOUNT_ID)?.trim();
	if (envAccessToken) {
		return { accessToken: envAccessToken, accountId: envAccountId || undefined };
	}

	const piAuth = getPiAuthFile()?.["openai-codex"];
	if (piAuth?.access?.trim()) {
		return {
			accessToken: piAuth.access.trim(),
			accountId: piAuth.accountId?.trim() || undefined,
		};
	}

	const legacyAuth = readJsonFile<LegacyCodexAuthFile>(join(homedir(), ".codex", "auth.json"));
	const legacyToken = legacyAuth?.tokens?.access_token?.trim();
	if (legacyToken) {
		return {
			accessToken: legacyToken,
			accountId: legacyAuth?.tokens?.account_id?.trim() || undefined,
		};
	}

	return {};
}

function clampPercent(value: number | undefined): number {
	if (typeof value !== "number" || Number.isNaN(value)) return 0;
	return Math.max(0, Math.min(100, Math.round(value)));
}

function formatReset(date: Date): string {
	const diffMs = date.getTime() - Date.now();
	if (diffMs <= 0) return "now";

	const diffMins = Math.floor(diffMs / 60_000);
	if (diffMins < 60) return `${diffMins}m`;

	const hours = Math.floor(diffMins / 60);
	const mins = diffMins % 60;
	if (hours < 24) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;

	const days = Math.floor(hours / 24);
	const remHours = hours % 24;
	return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
}

function formatWindow(label: string, percent: number | undefined, resetAt: Date | undefined): string {
	const pct = `${clampPercent(percent)}%`;
	const reset = resetAt ? ` ${formatReset(resetAt)}` : "";
	return `${label} ${pct}${reset}`;
}

function getCodexWindowLabel(windowSeconds: number | undefined, fallbackWindowSeconds: number): string {
	const seconds = typeof windowSeconds === "number" && windowSeconds > 0 ? windowSeconds : fallbackWindowSeconds;
	const hours = Math.round(seconds / 3600);
	if (hours >= 144) return "Wk";
	if (hours >= 24) return "Day";
	return `${hours}h`;
}

function detectSupportedProvider(ctx: ExtensionContext): SupportedProvider | undefined {
	const provider = ctx.model?.provider?.toLowerCase() || "";
	if (provider.includes("anthropic")) return "anthropic";
	if (provider.includes("openai-codex")) return "openai-codex";
	return undefined;
}

function getProviderIcon(provider: SupportedProvider): string {
	return provider === "anthropic" ? "✦" : "◎";
}

async function fetchJson(url: string, init: RequestInit): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

async function fetchAnthropicLine(): Promise<string | undefined> {
	const token = loadAnthropicOauthToken();
	if (!token) return undefined;

	const response = await fetchJson("https://api.anthropic.com/api/oauth/usage", {
		headers: {
			Authorization: `Bearer ${token}`,
			"anthropic-beta": "oauth-2025-04-20",
		},
	});
	if (!response.ok) return undefined;

	const data = (await response.json()) as AnthropicUsageResponse;
	const fiveHourReset = data.five_hour?.resets_at ? new Date(data.five_hour.resets_at) : undefined;
	const weekReset = data.seven_day?.resets_at ? new Date(data.seven_day.resets_at) : undefined;

	const parts = [];
	if (data.five_hour) parts.push(formatWindow("5h", data.five_hour.utilization, fiveHourReset));
	if (data.seven_day) parts.push(formatWindow("Wk", data.seven_day.utilization, weekReset));
	if (parts.length === 0) return undefined;
	return `Claude ${parts.join(" · ")}`;
}

async function fetchCodexLine(): Promise<string | undefined> {
	const { accessToken, accountId } = loadCodexAuth();
	if (!accessToken) return undefined;

	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
		Accept: "application/json",
	};
	if (accountId) headers["ChatGPT-Account-Id"] = accountId;

	const response = await fetchJson("https://chatgpt.com/backend-api/wham/usage", { headers });
	if (!response.ok) return undefined;

	const data = (await response.json()) as CodexUsageResponse;
	const primary = data.rate_limit?.primary_window;
	const secondary = data.rate_limit?.secondary_window;

	const parts = [];
	if (primary) {
		const resetAt = primary.reset_at ? new Date(primary.reset_at * 1000) : undefined;
		parts.push(formatWindow(getCodexWindowLabel(primary.limit_window_seconds, 10_800), primary.used_percent, resetAt));
	}
	if (secondary) {
		const resetAt = secondary.reset_at ? new Date(secondary.reset_at * 1000) : undefined;
		parts.push(formatWindow(getCodexWindowLabel(secondary.limit_window_seconds, 86_400), secondary.used_percent, resetAt));
	}
	if (parts.length === 0) return undefined;
	return `Codex ${parts.join(" · ")}`;
}

export default function subUsageLite(pi: ExtensionAPI): void {
	const cache = new Map<SupportedProvider, CacheEntry>();
	let refreshVersion = 0;

	async function getLine(provider: SupportedProvider, force = false): Promise<string | undefined> {
		const cached = cache.get(provider);
		if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
			return cached.line;
		}

		let line: string | undefined;
		try {
			line = provider === "anthropic" ? await fetchAnthropicLine() : await fetchCodexLine();
		} catch {
			line = cached?.line;
		}

		cache.set(provider, {
			fetchedAt: Date.now(),
			line,
		});
		return line;
	}

	async function refresh(ctx: ExtensionContext, force = false): Promise<void> {
		if (!ctx.hasUI) return;

		const provider = detectSupportedProvider(ctx);
		const version = ++refreshVersion;
		if (!provider) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		const line = await getLine(provider, force);
		if (version !== refreshVersion) return;
		ctx.ui.setStatus(STATUS_KEY, line ? `${getProviderIcon(provider)} ${line}` : undefined);
	}

	pi.on("session_start", async (_event, ctx) => {
		await refresh(ctx, true);
	});

	pi.on("model_select", async (_event, ctx) => {
		await refresh(ctx, true);
	});

	pi.on("turn_end", async (_event, ctx) => {
		await refresh(ctx, false);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	});
}
