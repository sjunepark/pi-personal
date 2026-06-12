import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { LoopState } from "./types.js";

export const POST_REVIEW_LOOP_START_EVENT = "post-review-loop:start";

export type PostReviewLoopStartRequest = {
	ctx: ExtensionContext;
	scope: string;
	limit?: number;
	reviewOnly?: boolean;
	gitCheckpoint?: boolean;
	compact?: boolean;
	source?: string;
	onResult?: (result: PostReviewLoopStartResult) => void;
};

export type PostReviewLoopStartResult =
	| {
			ok: true;
			state: LoopState;
	  }
	| {
			ok: false;
			reason: string;
	  };
