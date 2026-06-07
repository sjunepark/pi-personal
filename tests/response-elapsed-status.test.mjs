import test from "node:test";
import assert from "node:assert/strict";
import responseElapsedStatus, { formatElapsedDuration } from "../extensions/response-elapsed-status.ts";

test("elapsed status formats sub-hour durations as mm:ss", () => {
	assert.equal(formatElapsedDuration(0), "elapsed 00:00");
	assert.equal(formatElapsedDuration(1_000), "elapsed 00:01");
	assert.equal(formatElapsedDuration(84_900), "elapsed 01:24");
	assert.equal(formatElapsedDuration(59 * 60_000 + 59_000), "elapsed 59:59");
});

test("elapsed status formats hour-plus durations without dropping hours", () => {
	assert.equal(formatElapsedDuration(60 * 60_000), "elapsed 1:00:00");
	assert.equal(formatElapsedDuration(25 * 60 * 60_000 + 2 * 60_000 + 3_000), "elapsed 25:02:03");
});

test("elapsed status clamps negative durations to zero", () => {
	assert.equal(formatElapsedDuration(-1_000), "elapsed 00:00");
});

test("elapsed status includes time between user input and agent start", async () => {
	const harness = createHarness();
	const { ctx, statuses } = createCtx();
	const restoreNow = stubDateNow(1_000);

	try {
		await harness.emit("input", {}, ctx);
		restoreNow.set(4_000);
		await harness.emit("before_agent_start", {}, ctx);
		assert.deepEqual(statuses.at(-1), { key: "response-elapsed", text: "elapsed 00:03" });

		restoreNow.set(5_000);
		await harness.emit("agent_end", {}, ctx);
		assert.deepEqual(statuses.at(-1), { key: "response-elapsed", text: "elapsed 00:04" });
	} finally {
		await harness.emit("session_shutdown", {}, ctx);
		restoreNow();
	}
});

test("elapsed status resets when a new user input arrives mid-response", async () => {
	const harness = createHarness();
	const { ctx, statuses } = createCtx();
	const restoreNow = stubDateNow(0);

	try {
		await harness.emit("before_agent_start", {}, ctx);
		restoreNow.set(10_000);
		await harness.emit("input", {}, ctx);
		assert.deepEqual(statuses.at(-1), { key: "response-elapsed", text: "elapsed 00:00" });

		restoreNow.set(12_000);
		await harness.emit("agent_end", {}, ctx);
		assert.deepEqual(statuses.at(-1), { key: "response-elapsed", text: "elapsed 00:02" });
	} finally {
		await harness.emit("session_shutdown", {}, ctx);
		restoreNow();
	}
});

test("elapsed status does not reset for queued extension follow-ups mid-response", async () => {
	const harness = createHarness();
	const { ctx, statuses } = createCtx();
	const restoreNow = stubDateNow(0);

	try {
		await harness.emit("before_agent_start", {}, ctx);
		restoreNow.set(10_000);
		await harness.emit("input", { source: "extension", streamingBehavior: "followUp" }, ctx);
		assert.deepEqual(statuses.at(-1), { key: "response-elapsed", text: "elapsed 00:00" });

		restoreNow.set(12_000);
		await harness.emit("agent_end", {}, ctx);
		assert.deepEqual(statuses.at(-1), { key: "response-elapsed", text: "elapsed 00:12" });
	} finally {
		await harness.emit("session_shutdown", {}, ctx);
		restoreNow();
	}
});

function createHarness() {
	const handlers = new Map();
	responseElapsedStatus({
		on(event, handler) {
			handlers.set(event, handler);
		},
	});

	return {
		emit(event, payload, ctx) {
			const handler = handlers.get(event);
			return handler?.(payload, ctx);
		},
	};
}

function createCtx() {
	const statuses = [];
	return {
		statuses,
		ctx: {
			hasUI: true,
			ui: {
				theme: {
					fg(_color, text) {
						return text;
					},
				},
				setStatus(key, text) {
					statuses.push({ key, text });
				},
			},
		},
	};
}

function stubDateNow(initialNow) {
	const originalNow = Date.now;
	let now = initialNow;
	Date.now = () => now;

	function restore() {
		Date.now = originalNow;
	}
	restore.set = (nextNow) => {
		now = nextNow;
	};
	return restore;
}
