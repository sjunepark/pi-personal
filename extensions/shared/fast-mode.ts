import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export type FastModeState = {
	enabled: boolean;
	explicit?: boolean;
};

export type FastModeModel = {
	provider: string;
	id: string;
};

export type FastSupport = {
	supported: boolean;
	reason: string;
};

export const FAST_MODE_STATE_ENTRY_TYPE = "fast-mode-state";

// Keep these exact IDs aligned with @mariozechner/pi-ai's generated model registry.
const FAST_SUPPORTED_MODELS_BY_PROVIDER: Record<string, ReadonlySet<string>> = {
	openai: new Set([
		"gpt-5.4",
		"gpt-5.4-mini",
		"gpt-5.4-nano",
		"gpt-5.4-pro",
		"gpt-5.5",
		"gpt-5.5-pro",
	]),
	"openai-codex": new Set(["gpt-5.4", "gpt-5.4-mini", "gpt-5.5"]),
};

function getSupportedModelIds(provider: string): ReadonlySet<string> | undefined {
	return FAST_SUPPORTED_MODELS_BY_PROVIDER[provider.toLowerCase()];
}

function formatSupportedModels(provider: string): string {
	const modelIds = getSupportedModelIds(provider);
	return modelIds ? Array.from(modelIds).join(", ") : "none";
}

export function getCurrentFastModeModel(ctx: ExtensionContext): FastModeModel | undefined {
	const provider = ctx.model?.provider?.trim();
	const id = ctx.model?.id?.trim();
	if (!provider || !id) return undefined;
	return { provider, id };
}

export function parseFastModeModel(model: string | undefined): FastModeModel | undefined {
	if (!model) return undefined;
	const slash = model.indexOf("/");
	if (slash <= 0 || slash === model.length - 1) return undefined;
	const provider = model.slice(0, slash).trim();
	const id = model.slice(slash + 1).trim();
	if (!provider || !id) return undefined;
	return { provider, id };
}

export function getFastSupportForModel(model: FastModeModel | undefined): FastSupport {
	if (!model) {
		return {
			supported: false,
			reason: "No active model selected.",
		};
	}

	const provider = model.provider.toLowerCase();
	const modelId = model.id.toLowerCase();
	const supportedModelIds = getSupportedModelIds(provider);

	if (!supportedModelIds) {
		return {
			supported: false,
			reason: `Unsupported provider: ${model.provider}. Fast mode is only enabled for openai and openai-codex providers.`,
		};
	}

	if (!supportedModelIds.has(modelId)) {
		return {
			supported: false,
			reason: `Unsupported model: ${model.id}. Fast mode is currently limited to ${model.provider} models: ${formatSupportedModels(provider)}.`,
		};
	}

	return {
		supported: true,
		reason: `${model.provider}/${model.id} supports fast mode.`,
	};
}

export function restoreFastModeState(ctx: ExtensionContext): FastModeState | undefined {
	const entry = ctx.sessionManager
		.getEntries()
		.filter((item: { type: string; customType?: string }) => item.type === "custom" && item.customType === FAST_MODE_STATE_ENTRY_TYPE)
		.pop() as { data?: FastModeState } | undefined;

	if (!entry?.data) return undefined;

	return {
		enabled: entry.data.enabled === true,
		explicit: entry.data.explicit ?? true,
	};
}

export function getDefaultFastModeEnabled(ctx: ExtensionContext): boolean {
	return getFastSupportForModel(getCurrentFastModeModel(ctx)).supported;
}

export function isFastModeRequested(ctx: ExtensionContext): boolean {
	return restoreFastModeState(ctx)?.enabled ?? getDefaultFastModeEnabled(ctx);
}

export function patchPayloadWithFastMode(payload: unknown): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	return {
		...(payload as Record<string, unknown>),
		service_tier: "priority",
	};
}
