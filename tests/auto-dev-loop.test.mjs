import test from "node:test";
import assert from "node:assert/strict";
import {
	AUTO_DEV_ENTRY_TYPE,
	DEFAULT_REVIEW_LIMIT,
	POST_REVIEW_LOOP_ENTRY_TYPE,
	createAutoDevState,
	latestAutoDevStateFromEntries,
	latestPostReviewLoopStateByIdFromEntries,
	latestPostReviewLoopStateFromEntries,
	parseAutoDevStartArgs,
	renderAutoDevCompactionRequestPrompt,
	renderTaskPrompt,
	reviewScopeForTask,
	unresolvedBucketIIItems,
} from "../extensions/shared/auto-dev-loop.ts";

function customEntry(customType, data) {
	return { type: "custom", customType, data };
}

test("auto-dev state defaults to looping over common task files", () => {
	const state = createAutoDevState();

	assert.equal(state.lifecycle, "active");
	assert.equal(state.iteration, 1);
	assert.equal(state.once, false);
	assert.equal(state.reviewLimit, 5);
	assert.deepEqual(state.taskFiles, ["TODO.md", "PLAN.md", "ROADMAP.md", "TASKS.md", "PLAN-*.md"]);
});

test("auto-dev start args parse documented options", () => {
	assert.deepEqual(parseAutoDevStartArgs('--once --review-limit=3 --no-compact-between-tasks --task-files TODO.md,PLAN.md "ROADMAP.md"'), {
		once: true,
		reviewLimit: 3,
		compactBetweenTasks: false,
		taskFiles: ["TODO.md", "PLAN.md", "ROADMAP.md"],
	});
	assert.deepEqual(parseAutoDevStartArgs("", { once: false }), { once: false, reviewLimit: DEFAULT_REVIEW_LIMIT, compactBetweenTasks: undefined, taskFiles: [] });
});

test("auto-dev state validates review limit", () => {
	assert.throws(() => createAutoDevState({ reviewLimit: 0 }), /review limit/);
});

test("auto-dev state restores the latest persisted state and honors clear", () => {
	const first = createAutoDevState({ once: true });
	const second = { ...createAutoDevState(), iteration: 3 };

	assert.equal(
		latestAutoDevStateFromEntries([
			customEntry(AUTO_DEV_ENTRY_TYPE, { version: 1, state: first, event: "started", at: 1 }),
			customEntry("other", { state: null }),
			customEntry(AUTO_DEV_ENTRY_TYPE, { version: 1, state: second, event: "next-task", at: 2 }),
		])?.iteration,
		3,
	);
	assert.equal(latestAutoDevStateFromEntries([customEntry(AUTO_DEV_ENTRY_TYPE, { version: 1, state: second, event: "started", at: 1 }), customEntry(AUTO_DEV_ENTRY_TYPE, { event: "cleared" })]), null);
});

test("task prompt encodes task choice, clarification policy, validation, and post-review handoff", () => {
	const prompt = renderTaskPrompt(createAutoDevState({ taskFiles: ["TODO.md"] }));

	assert.match(prompt, /task\/plan Markdown files/);
	assert.match(prompt, /Ask the user only for product policy, public contract, user intent, taste/);
	assert.match(prompt, /Do not ask for syntax, library API details/);
	assert.match(prompt, /Run the relevant existing validation/);
	assert.match(prompt, /auto_dev_task_result/);
	assert.match(prompt, /Do not manually start \/post-review-loop/);
});

test("review scope uses explicit scope or task fallback", () => {
	const state = createAutoDevState();
	assert.equal(
		reviewScopeForTask(state, { title: "Fix docs", summary: "done", filesChanged: ["README.md"], validation: [], reviewScope: "explicit scope" }),
		"explicit scope",
	);
	assert.match(reviewScopeForTask(state, { title: "Fix docs", summary: "done", filesChanged: ["README.md"], validation: [] }), /Fix docs/);
	assert.match(reviewScopeForTask(state, { title: "Fix docs", summary: "done", filesChanged: ["README.md"], validation: [] }), /README\.md/);
});

test("between-task compaction prompt requires agent-authored context and preserves auto-dev state", () => {
	const state = {
		...createAutoDevState({ taskFiles: ["TODO.md"], reviewLimit: 3 }),
		iteration: 4,
		lastMessage: "Bucket II decisions completed without code changes.",
		lastTask: {
			title: "Fix docs",
			summary: "Updated docs",
			filesChanged: ["README.md"],
			validation: [{ command: "npm test", result: "passed", notes: "34 tests passed" }],
		},
	};
	const prompt = renderAutoDevCompactionRequestPrompt(state, { percent: 55.25, tokens: 44000, contextWindow: 100000 });

	assert.match(prompt, /Auto-dev-loop between-task context checkpoint \(55\.3% \(44,000 tokens \/ 100,000\)\)/);
	assert.match(prompt, /Before continuing, call compact_conversation/);
	assert.match(prompt, /Auto-dev-loop handoff facts to preserve/);
	assert.match(prompt, /Fix docs/);
	assert.match(prompt, /README\.md/);
	assert.match(prompt, /npm test: passed/);
	assert.match(prompt, /After compaction: the auto-dev-loop extension will inject the next task prompt automatically/);
	assert.match(prompt, /Do not choose or start a new task/);
});

test("post-review-loop restore helpers can target the tracked review id", () => {
	const first = { version: 1, id: "loop-1", scope: "first", lifecycle: "complete", bucketII: [] };
	const second = { version: 1, id: "loop-2", scope: "second", lifecycle: "active", bucketII: [] };
	const entries = [
		customEntry(POST_REVIEW_LOOP_ENTRY_TYPE, { version: 1, state: first, event: "final-report-rendered", at: 1 }),
		customEntry(POST_REVIEW_LOOP_ENTRY_TYPE, { version: 1, state: second, event: "started", at: 2 }),
	];

	assert.equal(latestPostReviewLoopStateFromEntries(entries).id, "loop-2");
	assert.equal(latestPostReviewLoopStateByIdFromEntries(entries, "loop-1").id, "loop-1");
	assert.equal(latestPostReviewLoopStateByIdFromEntries([...entries, customEntry(POST_REVIEW_LOOP_ENTRY_TYPE, { event: "cancelled" })], "loop-1"), null);
});

test("unresolved Bucket II helper keeps only current unresolved decisions", () => {
	const state = {
		bucketII: [
			{
				title: "Extract policy",
				revealed: "review",
				designSignal: "unclear ownership / boundary problem",
				weakness: "mixed policy",
				options: ["extract"],
				recommendedAction: "extract",
				tradeoffs: "more files",
				status: "left for user decision",
			},
			{
				title: "Already done",
				revealed: "review",
				designSignal: "simple local mistake",
				weakness: "n/a",
				options: ["keep"],
				recommendedAction: "keep",
				tradeoffs: "none",
				status: "implemented after explicit approval",
			},
		],
	};

	assert.deepEqual(
		unresolvedBucketIIItems(state).map((item) => item.title),
		["Extract policy"],
	);
});
