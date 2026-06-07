import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "response-elapsed";
const UPDATE_INTERVAL_MS = 1_000;

type ActiveTimer = {
	startedAt: number;
	interval: ReturnType<typeof setInterval>;
};

export function formatElapsedDuration(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);

	if (totalMinutes < 60) {
		return `elapsed ${pad2(totalMinutes)}:${pad2(seconds)}`;
	}

	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);
	return `elapsed ${hours}:${pad2(minutes)}:${pad2(seconds)}`;
}

function pad2(value: number): string {
	return value.toString().padStart(2, "0");
}

function formatStatus(ctx: ExtensionContext, startedAt: number): string {
	return ctx.ui.theme.fg("dim", formatElapsedDuration(Date.now() - startedAt));
}

export default function responseElapsedStatus(pi: ExtensionAPI): void {
	let activeTimer: ActiveTimer | undefined;
	let pendingPromptStartedAt: number | undefined;

	function stopTimer(): ActiveTimer | undefined {
		const timer = activeTimer;
		if (!timer) return undefined;

		clearInterval(timer.interval);
		activeTimer = undefined;
		return timer;
	}

	function updateStatus(ctx: ExtensionContext, startedAt: number): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, formatStatus(ctx, startedAt));
	}

	function startTimer(ctx: ExtensionContext, startedAt = Date.now()): void {
		stopTimer();
		if (!ctx.hasUI) return;

		updateStatus(ctx, startedAt);

		const interval = setInterval(() => updateStatus(ctx, startedAt), UPDATE_INTERVAL_MS);
		(interval as { unref?: () => void }).unref?.();

		activeTimer = { startedAt, interval };
	}

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" && activeTimer) return;

		pendingPromptStartedAt = Date.now();
		if (activeTimer) {
			startTimer(ctx, pendingPromptStartedAt);
		}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const startedAt = pendingPromptStartedAt;
		pendingPromptStartedAt = undefined;
		startTimer(ctx, startedAt);
	});

	pi.on("agent_end", async (_event, ctx) => {
		const timer = stopTimer();
		if (!timer) return;

		updateStatus(ctx, timer.startedAt);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		pendingPromptStartedAt = undefined;
		stopTimer();
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	});
}
