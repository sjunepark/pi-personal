import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	FAST_MODE_STATE_ENTRY_TYPE,
	getCurrentFastModeModel,
	getDefaultFastModeEnabled,
	getFastSupportForModel,
	patchPayloadWithFastMode,
	restoreFastModeState,
	type FastModeState,
} from "./shared/fast-mode.js";

const STATUS_KEY = "fast-mode";

function getFastSupport(ctx: ExtensionContext) {
	return getFastSupportForModel(getCurrentFastModeModel(ctx));
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
	pi.appendEntry(FAST_MODE_STATE_ENTRY_TYPE, { enabled, explicit: true } satisfies FastModeState);
}

/**
 * New sessions request fast mode by default only for models that support it,
 * so unsupported models do not request priority service.
 */
function getDefaultEnabled(ctx: ExtensionContext): boolean {
	return getDefaultFastModeEnabled(ctx);
}

function formatStatusMessage(ctx: ExtensionContext, enabled: boolean): string {
	const model = getCurrentFastModeModel(ctx);
	const support = getFastSupport(ctx);
	const modelLabel = model ? `${model.provider}/${model.id}` : "(no model)";
	const requested = enabled ? "on" : "off";
	const effective = enabled && support.supported ? "on" : "off";
	return `fast requested: ${requested} · effective: ${effective} · model: ${modelLabel} · ${support.reason}`;
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
		const restoredState = restoreFastModeState(ctx);
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
