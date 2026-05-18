import type { GateDecision, GateSnapshot, Phase, Verdict } from "./types.js";

function verdictFor(reason: string): Verdict {
	if (reason.includes("Bucket II")) return "Loop stopped: Bucket II decision needed";
	if (reason.includes("iteration limit")) return "Loop stopped: iteration limit reached";
	if (reason.includes("validation")) return "Loop stopped: validation failure remains";
	if (reason.includes("scope") || reason.includes("context")) return "Loop stopped: scope or context needed";
	if (reason.includes("checkpoint")) return "Loop stopped: phase checkpoint unavailable";
	return "Loop clean: no accepted/actionable Bucket I findings remain";
}

function stop(reason: string): GateDecision {
	return {
		decision: "stop",
		nextPhase: "final-report",
		checkpointRequired: false,
		reason,
		verdict: verdictFor(reason),
	};
}

function cont(nextPhase: Phase, reason: string): GateDecision {
	return { decision: "continue", nextPhase, checkpointRequired: true, reason };
}

export function decideNext(snapshot: GateSnapshot): GateDecision {
	if (snapshot.limit < 1) throw new Error("limit must be at least 1");
	if (snapshot.iteration < 1) throw new Error("iteration must be at least 1");

	if (snapshot.checkpointUnavailable) return stop("phase checkpoint unavailable");
	if (snapshot.reviewOnly) return stop("user requested a review-only pass");
	if (snapshot.scopeBlocked) return stop("scope or context is missing");
	if (snapshot.validationBlocked) return stop("validation is blocking safe continuation");

	if (snapshot.phase === "post-review") {
		if (snapshot.bucketICandidates === 0) {
			if (snapshot.bucketII > 0) return stop("only Bucket II work remains");
			return stop("no Bucket I candidates found");
		}
		if (snapshot.iteration >= snapshot.limit) return stop("iteration limit reached after post-review");
		return cont("impl-review", "Bucket I candidates exist; checkpoint before verification/planning");
	}

	if (snapshot.phase === "impl-review") {
		if (snapshot.acceptedBucketI === 0) {
			if (snapshot.bucketII > 0) return stop("only Bucket II work remains");
			return stop("no accepted/actionable Bucket I items remain");
		}
		if (snapshot.iteration >= snapshot.limit) return stop("iteration limit reached before implementation");
		return cont("impl", "accepted/actionable Bucket I work exists; checkpoint before implementation");
	}

	if (snapshot.appliedBucketI === 0) return stop("implementation phase applied no Bucket I fixes");
	return cont("post-review", "implementation completed; checkpoint before the next review");
}
