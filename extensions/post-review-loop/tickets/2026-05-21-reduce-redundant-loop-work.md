# Reduce redundant work in post-review-loop

## Summary

The post-review-loop can take much longer than the underlying code review warrants because it repeatedly re-inspects the same diff, reruns unchanged validation commands, and splits closely related findings across multiple checkpointed phases. Improve the extension so it preserves correctness while avoiding redundant work when the reviewed files, findings, and validation inputs have not materially changed.

## Triggering case

A renderer run-session refactor in the Creo app took several review-loop phases. The loop did find real issues, but it also repeated work that could have been cached or batched:

- Repeated staged/unstaged/untracked worktree inspection after every checkpoint.
- Repeated broad diff inspection over mostly unchanged files.
- Repeated focused validation commands after changes that did not affect all validated inputs.
- Separate phases for two closely related toolbar readiness/action bugs.
- Context reconstruction after checkpoint compaction caused the model to re-read overlapping files and diffs.

The two real findings were related to the same state boundary:

1. Toolbar labels used projection enablement where bridge/app-settings readiness should drive availability labels.
2. The repair-labeled run action was still disabled/no-op after restoring a completed run because `workflowRunAction === "complete"` won over app-settings repair readiness.

A state-matrix-oriented review likely would have caught both together.

## Problem

The extension currently optimizes for safety by forcing each phase to independently inspect files, submit evidence, validate, and checkpoint. That is correct but inefficient when:

- The worktree has not changed since the last inspection.
- A command was already run against the same file contents.
- Multiple Bucket I items touch the same small set of files and state conditions.
- Checkpoint compaction forces the next prompt to rehydrate context from a compact ledger instead of a precise phase cache.

## Goals

- Preserve the requirement that the model inspects real files/diffs before submitting phase results.
- Avoid rerunning expensive or redundant checks when their relevant inputs did not change.
- Encourage batching of related Bucket I fixes before checkpointing.
- Improve review prompts for UI state/enablement bugs so related state combinations are reviewed together.
- Keep the human final report concise and trustworthy.

## Proposed improvements

### 1. Track phase worktree fingerprints

Record a fingerprint for each phase submission, including:

- `HEAD`
- staged diff hash
- unstaged diff hash
- untracked file list/hash
- optionally per-file content hashes for files in `changedFiles`

Use this to tell the next phase when the working tree is unchanged except for known loop edits. The prompt can then say something like:

> Previous inspection is still valid for files A/B/C; re-inspect only files changed since phase N plus any files needed for the new finding.

### 2. Cache validation by command and input hash

Persist validation rows with:

- command string
- cwd
- relevant file set if known
- hash of relevant files or full worktree diff hash
- result and timestamp

When a later phase asks for the same command and the input hash is unchanged, surface it as reusable validation instead of requiring a rerun. The model should still be allowed to rerun when uncertain.

Acceptance behavior:

- If touched files changed since the cached command, invalidate the cache.
- If the command has unknown inputs, fall back to conservative invalidation by full worktree hash.
- The final report should distinguish `reused` validation from freshly run validation if useful for audit mode.

### 3. Batch related Bucket I items

When active Bucket I findings share files or normalized state domains, avoid checkpointing after the first implementation if more accepted items are likely in the same area.

Heuristic examples:

- Same file set overlap above a threshold.
- Same normalized terms in title/fix, such as `toolbar`, `readiness`, `repair`, `complete`, `disabled`.
- Same component or module path.

Possible gate behavior:

- After impl-review accepts a Bucket I item, if similar candidate/accepted items exist or the review mentions related state combinations, advance to one implementation phase with all related items.
- Defer checkpoint compaction until the batch is implemented and validated.

### 4. Add state-matrix review prompts for UI enablement issues

For findings involving labels, disabled state, readiness, availability, or actions, include an explicit prompt section asking the model to check relevant combinations.

Example matrix dimensions:

- bridge readiness: loading / ready / error
- app settings: loading / ready / repairable / unavailable
- run action: run / resume / complete
- in-flight state: idle / running / restoring

The extension does not need to know the exact app semantics. It can add a generic checklist when Bucket I text or changed files mention toolbar, button, disabled, label, readiness, action, repair, permission, bridge, settings, or availability.

### 5. Separate required re-inspection from reusable evidence

Current prompts strongly imply every phase must re-inspect everything. Keep the safety rule, but allow the extension to identify evidence that is still current.

Suggested prompt language:

> You may cite prior inspection facts listed under `still-current evidence` when the file hash is unchanged. You must inspect any file changed since that evidence or any new file needed for this phase.

### 6. Reduce compaction-induced context loss

When checkpoint compaction is queued, preserve a structured mini-cache beyond the compact ledger:

- current active findings with exact files and rationale
- last inspected file hashes
- last validation cache entries
- state matrix already checked, if any
- why the last gate advanced

This should be machine-readable and model-facing enough that the next phase does not have to rebuild all context from scratch.

## Acceptance criteria

- A loop with no worktree changes between review phases does not require repeating the same staged/unstaged/untracked inspection in full prose; it can cite an unchanged worktree fingerprint.
- Re-running the same focused validation command is not required when relevant file hashes are unchanged.
- Related Bucket I findings in the same files can be implemented in one impl phase.
- UI toolbar/button/readiness reviews include a state-combination checklist or matrix prompt.
- The final report remains accurate about what was freshly run versus reused.
- Conservative fallback remains available: if hashes cannot be computed or command inputs are unclear, the loop should require fresh inspection/validation.

## Non-goals

- Do not skip real file/diff inspection for new or changed files.
- Do not trust model memory without extension-provided fingerprints or cached evidence.
- Do not remove checkpointing entirely; make it less repetitive.
- Do not automatically implement Bucket II decisions.

## Suggested implementation areas

Likely files in this extension:

- `extensions/post-review-loop/state.ts` — persist worktree fingerprints and validation cache.
- `extensions/post-review-loop/git.ts` — compute diff/file hashes and changed-file sets.
- `extensions/post-review-loop/gate.ts` — batch related Bucket I findings and decide when checkpointing is useful.
- `extensions/post-review-loop/prompts.ts` — add reusable-evidence sections and UI state-matrix checklist.
- `extensions/post-review-loop/report.ts` — optionally show reused validation in full/audit reports.
- `extensions/post-review-loop/types.ts` — add structured cache types.

## Notes

The slowdown was not entirely wasted: the loop found real root-cause issues. The target is to keep that review quality while reducing repeated inspection, repeated validation, and phase fragmentation for tightly related findings.
