import test from "node:test";
import assert from "node:assert/strict";
import subUsageLite from "../extensions/sub-usage-lite.ts";

test("sub usage ignores refreshes that finish after session shutdown", async () => {
	const originalFetch = globalThis.fetch;
	const originalToken = process.env.ANTHROPIC_OAUTH_TOKEN;
	const fetchStarted = deferred();
	const fetchRelease = deferred();
	const state = { rejectPiUse: false, rejectStatuses: false };
	const harness = createHarness(state);
	const { ctx, statuses } = createCtx(state);

	process.env.ANTHROPIC_OAUTH_TOKEN = "test-token";
	globalThis.fetch = async () => {
		fetchStarted.resolve();
		await fetchRelease.promise;
		return {
			ok: true,
			json: async () => ({ five_hour: { utilization: 12 } }),
		};
	};

	try {
		const refresh = harness.emit("model_select", {}, ctx);
		await fetchStarted.promise;

		await harness.emit("session_shutdown", {}, ctx);
		state.rejectPiUse = true;
		state.rejectStatuses = true;

		fetchRelease.resolve();
		await refresh;

		assert.deepEqual(statuses, [{ key: "sub-usage-lite", text: undefined }]);
	} finally {
		globalThis.fetch = originalFetch;
		if (originalToken === undefined) {
			delete process.env.ANTHROPIC_OAUTH_TOKEN;
		} else {
			process.env.ANTHROPIC_OAUTH_TOKEN = originalToken;
		}
	}
});

function createHarness(state) {
	const handlers = new Map();
	subUsageLite({
		on(event, handler) {
			handlers.set(event, handler);
		},
		getThinkingLevel() {
			if (state.rejectPiUse) throw new Error("stale pi used");
			return "minimal";
		},
	});

	return {
		emit(event, payload, ctx) {
			const handler = handlers.get(event);
			return handler?.(payload, ctx);
		},
	};
}

function createCtx(state) {
	const statuses = [];
	return {
		statuses,
		ctx: {
			hasUI: true,
			model: { provider: "anthropic", reasoning: true },
			ui: {
				setStatus(key, text) {
					if (state.rejectStatuses) throw new Error("stale ctx used");
					statuses.push({ key, text });
				},
			},
		},
	};
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}
