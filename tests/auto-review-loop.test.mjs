import test from "node:test";
import assert from "node:assert/strict";
import {
	AUTO_REVIEW_ENTRY_TYPE,
	DEFAULT_REVIEW_DIMENSIONS,
	actionableBucketIItems,
	createAutoReviewState,
	latestAutoReviewStateFromEntries,
	latestPostReviewLoopStateByIdFromEntries,
	markReviewSliceCompleted,
	parseAutoReviewStartArgs,
	renderFindingDecisionPrompt,
	renderReviewPrompt,
	reviewScopeForResult,
	reviewSliceKey,
	selectNextReviewSlice,
	unresolvedBucketIIItems,
} from "../extensions/shared/auto-review-loop.ts";

function customEntry(customType, data) {
	return { type: "custom", customType, data };
}

test("auto-review state defaults to repo review areas and dimensions", () => {
	const state = createAutoReviewState();

	assert.equal(state.lifecycle, "active_reviewing");
	assert.equal(state.iteration, 1);
	assert.equal(state.once, false);
	assert.equal(state.reviewLimit, 5);
	assert.deepEqual(state.dimensions, DEFAULT_REVIEW_DIMENSIONS);
	assert.deepEqual(
		state.areas.map((area) => area.id),
		["plans", "extensions", "tests", "package"],
	);
});

test("auto-review start args parse documented options", () => {
	assert.deepEqual(parseAutoReviewStartArgs('--once --review-limit=3 --dimensions correctness,docs "errors"'), {
		once: true,
		reviewLimit: 3,
		dimensions: ["correctness", "docs", "errors"],
	});
	assert.deepEqual(parseAutoReviewStartArgs("", { once: false }), { once: false, reviewLimit: 5, dimensions: [] });
});

test("auto-review state validates review limit", () => {
	assert.throws(() => createAutoReviewState({ reviewLimit: 0 }), /review limit/);
});

test("auto-review restores latest persisted state and honors clear", () => {
	const first = createAutoReviewState({ once: true });
	const second = { ...createAutoReviewState(), iteration: 4 };

	assert.equal(
		latestAutoReviewStateFromEntries([
			customEntry(AUTO_REVIEW_ENTRY_TYPE, { version: 1, state: first, event: "started", at: 1 }),
			customEntry("other", { state: null }),
			customEntry(AUTO_REVIEW_ENTRY_TYPE, { version: 1, state: second, event: "next-review", at: 2 }),
		])?.iteration,
		4,
	);
	assert.equal(latestAutoReviewStateFromEntries([customEntry(AUTO_REVIEW_ENTRY_TYPE, { version: 1, state: second, event: "started", at: 1 }), customEntry(AUTO_REVIEW_ENTRY_TYPE, { event: "cleared" })]), null);
});

test("review slice selection advances through uncompleted area dimension cells", () => {
	const state = createAutoReviewState({
		areas: [
			{ id: "a", label: "Area A", files: ["a.ts"] },
			{ id: "b", label: "Area B", files: ["b.ts"] },
		],
		dimensions: ["correctness", "docs"],
	});
	const first = selectNextReviewSlice(state);
	assert.deepEqual(first, { areaId: "a", areaLabel: "Area A", files: ["a.ts"], dimension: "correctness" });

	const secondState = markReviewSliceCompleted(state, first);
	assert.equal(reviewSliceKey(first), "a:correctness");
	assert.deepEqual(selectNextReviewSlice(secondState), { areaId: "b", areaLabel: "Area B", files: ["b.ts"], dimension: "correctness" });
});

test("review prompt encodes conservative auto-fix and result-tool rules", () => {
	const state = createAutoReviewState({ areas: [{ id: "ext", label: "Extensions", files: ["extensions/**/*.ts"] }], dimensions: ["structure"] });
	const slice = selectNextReviewSlice(state);
	const prompt = renderReviewPrompt(state, slice);

	assert.match(prompt, /Review exactly one repository slice/);
	assert.match(prompt, /Apply code\/docs changes only for tiny obvious local fixes/);
	assert.match(prompt, /Do not auto-fix findings involving unclear ownership/);
	assert.match(prompt, /auto_review_result/);
	assert.match(prompt, /Do not manually start \/post-review-loop/);
});

test("finding decision prompt is phone-friendly", () => {
	const state = createAutoReviewState({ once: true });
	const prompt = renderFindingDecisionPrompt(state, [
		{
			title: "Split review policy",
			tier: "ask_user",
			designSignal: "unclear ownership / boundary problem",
			summary: "Review policy and persistence are mixed.",
			files: ["extensions/auto-review-loop.ts"],
			recommendedAction: "Extract policy helpers.",
			status: "found",
			userQuestion: "Should this be part of the first implementation?",
		},
	]);

	assert.match(prompt, /Reply normally/);
	assert.match(prompt, /short numbered answer is fine/);
	assert.match(prompt, /1\. fix now/);
	assert.match(prompt, /Should this be part/);
});

test("review scope summarizes the selected slice and changed files", () => {
	const state = createAutoReviewState();
	const slice = selectNextReviewSlice(state);
	const scope = reviewScopeForResult(state, {
		status: "fixed",
		slice,
		summary: "Fixed stale docs link.",
		filesReviewed: ["extensions/auto-review-loop.md"],
		filesChanged: ["extensions/auto-review-loop.md"],
		validation: [],
		findings: [],
		questions: [],
	});

	assert.match(scope, /auto-review iteration 1/);
	assert.match(scope, /plan and task documents/);
	assert.match(scope, /Files changed: extensions\/auto-review-loop\.md/);
});

test("post-review restore helper targets the tracked loop id", () => {
	const first = { version: 1, id: "loop-1", scope: "first", lifecycle: "complete", bucketI: [], bucketII: [] };
	const second = { version: 1, id: "loop-2", scope: "second", lifecycle: "active", bucketI: [], bucketII: [] };
	const entries = [
		customEntry("post-review-loop-state", { version: 1, state: first, event: "final-report-rendered", at: 1 }),
		customEntry("post-review-loop-state", { version: 1, state: second, event: "started", at: 2 }),
	];

	assert.equal(latestPostReviewLoopStateByIdFromEntries(entries, "loop-1").id, "loop-1");
	assert.equal(latestPostReviewLoopStateByIdFromEntries([...entries, customEntry("post-review-loop-state", { event: "cancelled" })], "loop-1"), null);
});

test("post-review issue helpers keep current actionable decisions", () => {
	const state = {
		bucketI: [
			{
				title: "Fix guard",
				revealed: "review",
				designSignal: "weak validation or invariant gap",
				status: "candidate",
				fix: "Add local guard.",
				files: ["x.ts"],
				bandageReason: "root cause local",
				validation: [],
			},
			{
				title: "Done",
				revealed: "review",
				designSignal: "simple local mistake",
				status: "applied",
				fix: "Done.",
				files: ["x.ts"],
				bandageReason: "n/a",
				validation: [],
			},
		],
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
				title: "Already decided",
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
		actionableBucketIItems(state).map((item) => item.title),
		["Fix guard"],
	);
	assert.deepEqual(
		unresolvedBucketIIItems(state).map((item) => item.title),
		["Extract policy"],
	);
});
