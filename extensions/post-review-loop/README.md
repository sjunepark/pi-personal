# post-review-loop

Pi extension that owns the post-implementation review loop workflow.

## Commands

```text
/post-review-loop oneshot [--review-only] [scope]
/post-review-loop start [--limit N] [--review-only] [--no-git-checkpoint] [scope]
/post-review-loop status [--full]
/post-review-loop pause
/post-review-loop resume
/post-review-loop stop
/post-review-loop cancel
/post-review-loop report [--full]
```

## Model tools

- `post_review_loop_get_state`
- `post_review_loop_submit_phase_result`
- `post_review_loop_submit_final_commit_result`
- `post_review_loop_abort`

The model supplies phase findings, validation, submitted phase-scope files, and code-change facts. The extension persists the ledger, gates phase transitions, owns checkpoint compaction internally, and renders concise default reports; use `--full` for audit detail.

`/post-review-loop oneshot` is stateless. It injects the copied Post-Implementation Review behavior as a one-turn review-and-improve prompt, defaults to `uncommitted changes`, supports `--review-only`, and intentionally does not use the loop ledger, phase tools, checkpointing, compaction, or final-report machinery.

## Current v1 policies

- `/post-review-loop start` without a scope defaults to reviewing uncommitted changes. Provide a scope argument to review a different diff, branch, commit range, or implementation target.
- `/post-review-loop stop` and `/post-review-loop pause` are graceful drain requests: they let the currently requested iteration finish instead of aborting the active phase. `stop` renders the final report after that iteration; `pause` pauses before the next iteration prompt. Use `/post-review-loop cancel` to immediately abort any active turn, discard pending checkpoint work, and clear loop state.
- Git integration is deterministic and local-only. On start, the extension records the starting `HEAD`; if the worktree is dirty, it does not run `git add -A` or mechanically commit everything. The first phase prompt asks the agent to inspect the requested scope and create a selective ordinary project commit containing only review-relevant uncommitted changes, including partial hunks when needed. Use `--no-git-checkpoint` to record only and skip that prompt.
- The agent writes the selective checkpoint commit message freely as a normal project commit. Unrelated dirty files or hunks should remain uncommitted.
- If no uncommitted changes clearly belong to the review target, the agent should not commit and should continue reviewing the requested scope; reviews may target prior commits, branches, ranges, or implementation areas.
- When the default `uncommitted changes` scope gets a selective checkpoint commit, the first pass should treat `ORIGINAL_HEAD..HEAD` as the primary reviewed implementation boundary, plus any explicitly relevant uncommitted leftovers.
- On final completion, if validation/scope gates are not blocking and the loop itself applied code changes, the extension queues a final commit prompt instead of staging files itself. The agent must commit only loop-applied edits, using partial hunks when needed, then call `post_review_loop_submit_final_commit_result` so the extension can render the final report. Legacy sessions that already have a temporary before-review checkpoint can still be amended into a normal project commit.
- The extension does not push commits. It refuses automatic commits during active merge/rebase states and skips final commit/amend work when validation failed or scope/context blocked safe completion.
- Bucket I history is append-only. Active/current views coalesce findings by normalized title because v1 has no stable finding id; treat that as a display approximation, not a durable identity model.
- Human reports are concise by default: summary, reviewed target, applied fixes, remaining decisions, validation outcome, and changed-file summary. `report --full` expands phase logs, complete validation rows, rejected/kept-as-is rationale, and full Bucket I/Bucket II detail. Final report tool results include the markdown directly, and rendered markdown messages store the markdown in normal message content as well as renderer details so API clients can retrieve it without a TUI-only custom render path.
- Human reports group current Bucket I findings by outcome: applied by the loop, still actionable / not yet applied, and rejected or downgraded. This keeps candidates and accepted-but-unfixed work visibly separate from applied fixes.
- Bucket I items can remain unfixed when the loop stops before implementation, such as review-only mode, iteration limit, validation/scope blockage, checkpoint failure, or an explicit user stop. Bucket I means “safe, in-scope, root-cause-fixable work,” not “already fixed.” Accepted Bucket I items should normally be fixed by the following `impl` phase; if they cannot be fixed, the report must show them as still actionable instead of clean.
- Bucket I and Bucket II items include a `designSignal` classification learned from the bug-retro prompt: `simple local mistake`, `weak validation or invariant gap`, `unclear ownership / boundary problem`, `weak type or schema model`, `state, lifecycle, concurrency, or ordering hazard`, `over-abstraction, under-abstraction, or duplicated logic`, or `brittle integration or contract mismatch`. This keeps findings grounded in root cause instead of fix mechanics.
- Bucket II decision items are coalesced by normalized title. Later materially changed submissions replace the current view; unchanged existing items should be omitted from new phase submissions.
- Bucket II gates count only unresolved decision statuses. Items marked `implemented after explicit approval` remain in reports but do not block a clean stop.
- Phase `summary` is a short human-friendly explanation of what code or behavior was reviewed/changed in that phase. It is not a file list or a findings list.
- `reviewTargetBriefing` drives the report's `What Was Reviewed` section. It explains the review target itself, such as uncommitted changes, a named feature implementation, or a refactor, in one or two teaching-style paragraphs instead of listing review activity by phase.
- `changedFiles` / `filesChanged` means files inspected, reviewed, or touched during submitted phases. `codeChanges` is the authoritative loop-edit ledger and drives “files edited by loop” wording in reports.
- Checkpoint compaction is internal to this extension. There is no separate model-facing phase compaction tool; models continue by submitting phase results, and the extension decides whether to compact and advance.
- After each continuing phase, the extension evaluates a checkpoint but only runs compaction when current context usage is over 60%. At or below that threshold, it marks the checkpoint ready and injects the next authoritative phase prompt without summarizing the conversation.
- Checkpoint compaction summaries are intentionally minimal. The extension persists the canonical ledger outside model context and injects the next authoritative phase prompt after compaction, so compaction should not duplicate Bucket details, validation rows, hash caches, or prior prompts.
- Compact phase prompts batch active Bucket I/Bucket II ledger items instead of dumping an unbounded list. Hidden overflow remains active in the persisted ledger and gate decisions count the merged current ledger, so omitted items are queued for later phases instead of being treated as resolved.
- Phase submissions record worktree fingerprints, per-file hashes for inspected files, and validation cache entries. Later prompts may cite still-current evidence or reused validation when hashes match, but changed files and uncertain command inputs still require fresh inspection/validation. Validation gating treats later results for the same command/input fingerprint as superseding earlier failures, so a rerun that passes does not leave the loop blocked by stale failed attempts.
- Prompts encourage batching related Bucket I findings that share files, modules, or UI state domains before checkpointing. UI toolbar/button/readiness/action findings also get a generic state-combination checklist so related label/disabled/action cases are reviewed together.

## Workflow

```text
post-review -> impl-review -> impl -> post-review -> ... -> final-report
```

The extension is the source of truth for phase, iteration, status, ledger, checkpointing, final report shape, and the stateless one-shot post-implementation review prompt.
