import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type FastModeState = {
	enabled: boolean;
	explicit?: boolean;
};

type FastSupport = {
	supported: boolean;
	reason: string;
};

const STATUS_KEY = "fast-mode";
const STATE_ENTRY_TYPE = "fast-mode-state";

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

function getCurrentModel(ctx: ExtensionContext): { provider: string; id: string } | undefined {
	const provider = ctx.model?.provider?.trim();
	const id = ctx.model?.id?.trim();
	if (!provider || !id) return undefined;
	return { provider, id };
}

function getFastSupport(ctx: ExtensionContext): FastSupport {
	const model = getCurrentModel(ctx);
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

function getStatusText(ctx: ExtensionContext, enabled: boolean): string | undefined {
	const support = getFastSupport(ctx);
	if (support.supported) {
		return enabled ? "⚡ fast" : "fast off";
	}

	return enabled ? "fast unsupported" : undefined;
}

function updateStatus(ctx: ExtensionContext, enabled: boolean): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, getStatusText(ctx, enabled));
}

function persistState(pi: ExtensionAPI, enabled: boolean): void {
	pi.appendEntry(STATE_ENTRY_TYPE, { enabled, explicit: true } satisfies FastModeState);
}

function restoreState(ctx: ExtensionContext): FastModeState | undefined {
	const entry = ctx.sessionManager
		.getEntries()
		.filter((item: { type: string; customType?: string }) => item.type === "custom" && item.customType === STATE_ENTRY_TYPE)
		.pop() as { data?: FastModeState } | undefined;

	if (!entry?.data) return undefined;

	return {
		enabled: entry.data.enabled === true,
		explicit: entry.data.explicit ?? true,
	};
}

function getDefaultEnabled(ctx: ExtensionContext): boolean {
	return getFastSupport(ctx).supported;
}

function formatStatusMessage(ctx: ExtensionContext, enabled: boolean): string {
	const model = getCurrentModel(ctx);
	const support = getFastSupport(ctx);
	const modelLabel = model ? `${model.provider}/${model.id}` : "(no model)";
	const requested = enabled ? "on" : "off";
	const effective = enabled && support.supported ? "on" : "off";
	return `fast requested: ${requested} · effective: ${effective} · model: ${modelLabel} · ${support.reason}`;
}

function patchPayloadWithFastMode(payload: unknown): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	return {
		...(payload as Record<string, unknown>),
		service_tier: "priority",
	};
}

export default function fastMode(pi: ExtensionAPI): void {
	let enabled = false;
	let hasExplicitPreference = false;

	function setEnabled(next: boolean, ctx: ExtensionContext): void {
		enabled = next;
		hasExplicitPreference = true;
		persistState(pi, enabled);
		updateStatus(ctx, enabled);
	}

	function applyDefault(ctx: ExtensionContext): void {
		if (hasExplicitPreference) return;
		enabled = getDefaultEnabled(ctx);
		updateStatus(ctx, enabled);
	}

	pi.registerCommand("fast", {
		description: "Toggle Codex-style fast mode: /fast on|off|status",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			const support = getFastSupport(ctx);

			if (action === "" || action === "toggle") {
				if (!enabled && !support.supported) {
					ctx.ui.notify(support.reason, "warning");
					updateStatus(ctx, enabled);
					return;
				}
				setEnabled(!enabled, ctx);
				ctx.ui.notify(formatStatusMessage(ctx, enabled), "info");
				return;
			}

			if (action === "on") {
				if (!support.supported) {
					ctx.ui.notify(support.reason, "warning");
					updateStatus(ctx, enabled);
					return;
				}
				setEnabled(true, ctx);
				ctx.ui.notify(formatStatusMessage(ctx, enabled), "info");
				return;
			}

			if (action === "off") {
				setEnabled(false, ctx);
				ctx.ui.notify(formatStatusMessage(ctx, enabled), "info");
				return;
			}

			if (action === "status") {
				updateStatus(ctx, enabled);
				ctx.ui.notify(formatStatusMessage(ctx, enabled), "info");
				return;
			}

			ctx.ui.notify("Usage: /fast on|off|status", "warning");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const restoredState = restoreState(ctx);
		hasExplicitPreference = restoredState?.explicit === true;
		enabled = restoredState?.enabled ?? false;
		applyDefault(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		if (!hasExplicitPreference) {
			applyDefault(ctx);
			return;
		}
		updateStatus(ctx, enabled);
		if (!enabled) return;
		const support = getFastSupport(ctx);
		if (!support.supported && event.source !== "restore") {
			ctx.ui.notify(`Fast mode is still requested, but inactive on the current model. ${support.reason}`, "warning");
		}
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled) return;
		if (!getFastSupport(ctx).supported) return;
		return patchPayloadWithFastMode(event.payload);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
