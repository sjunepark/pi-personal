import type { GateDecision, GateSnapshot, Phase, Verdict } from "./types.js";

function verdictFor(reason: string): Verdict {
	if (reason.includes("Bucket II")) return "Loop stopped: Bucket II decision needed";
	if (reason.includes("iteration limit")) return "Loop stopped: iteration limit reached";
	if (reason.includes("validation")) return "Loop stopped: validation failure remains";
	if (reason.includes("Bucket I")) return "Loop stopped: Bucket I fixes were not applied";
	if (reason.includes("user requested stop")) return "Loop stopped: user requested stop";
	if (reason.includes("review-only")) return "Loop stopped: review-only pass completed";
	if (reason.includes("scope") || reason.includes("context")) return "Loop stopped: scope or context needed";
	return "Loop clean: no accepted/actionable Bucket I findings remain";
}

export function stopDecision(reason: string): GateDecision {
	return {
		decision: "stop",
		nextPhase: "final-report",
		phasePromptRequired: false,
		reason,
		verdict: verdictFor(reason),
	};
}

function cont(nextPhase: Phase, reason: string): GateDecision {
	return { decision: "continue", nextPhase, phasePromptRequired: true, reason };
}

export function decideNext(snapshot: GateSnapshot): GateDecision {
	if (snapshot.limit < 1) throw new Error("limit must be at least 1");
	if (snapshot.iteration < 1) throw new Error("iteration must be at least 1");

	if (snapshot.reviewOnly) {
		const hasUnappliedBucketI = snapshot.bucketICandidates > 0 || snapshot.acceptedBucketI > 0;
		return stopDecision(hasUnappliedBucketI ? "review-only pass completed with Bucket I items not applied" : "user requested a review-only pass");
	}
	if (snapshot.scopeBlocked) return stopDecision("scope or context is missing");
	if (snapshot.validationBlocked) return stopDecision("validation is blocking safe continuation");

	if (snapshot.phase === "post-review") {
		if (snapshot.bucketICandidates === 0) {
			if (snapshot.bucketII > 0) return stopDecision("only Bucket II work remains");
			return stopDecision("no Bucket I candidates found");
		}
		if (snapshot.iteration >= snapshot.limit) return stopDecision("iteration limit reached after post-review");
		return cont("impl-review", "Bucket I candidates exist; continue to verification/planning");
	}

	if (snapshot.phase === "impl-review") {
		if (snapshot.acceptedBucketI === 0) {
			if (snapshot.bucketII > 0) return stopDecision("only Bucket II work remains");
			return stopDecision("no accepted/actionable Bucket I items remain");
		}
		if (snapshot.iteration >= snapshot.limit) return stopDecision("iteration limit reached before implementation");
		return cont("impl", "accepted/actionable Bucket I work exists; continue to implementation");
	}

	if (snapshot.appliedBucketI === 0) return stopDecision("implementation phase applied no Bucket I fixes");
	return cont("post-review", "implementation completed; continue to the next review");
}
