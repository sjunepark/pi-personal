# post-review-loop

Pi extension that owns the post-implementation review loop workflow.

## Commands

```text
/post-review-loop start [--limit N] [--review-only] [--no-git-checkpoint] [scope]
/post-review-loop status [--full]
/post-review-loop pause
/post-review-loop resume
/post-review-loop stop
/post-review-loop report [--full]
/post-review-loop clear
```

## Model tools

- `post_review_loop_get_state`
- `post_review_loop_submit_phase_result`
- `post_review_loop_abort`

The model supplies phase findings, validation, submitted phase-scope files, and code-change facts. The extension persists the ledger, gates phase transitions, owns checkpoint compaction internally, and renders concise default reports; use `--full` for audit detail.

## Current v1 policies

- `/post-review-loop start` without a scope defaults to reviewing uncommitted changes. Provide a scope argument to review a different diff, branch, commit range, or implementation target.
- Git integration is deterministic and local-only. On start, the extension records the starting `HEAD`; if the worktree is dirty, it runs `git add -A` and creates a temporary `checkpoint(post-review-loop): before review` commit by default. Use `--no-git-checkpoint` to record only.
- After creating that temporary commit, the first phase prompt tells the agent to run `git commit --amend` with an ordinary project commit message before continuing, so interrupted loops do not leave checkpoint subjects in history.
- When the default `uncommitted changes` scope is checkpointed, the review scope becomes `ORIGINAL_HEAD..CHECKPOINT_HEAD` so the loop reviews the committed implementation boundary.
- On final completion, if validation/scope gates are not blocking, the extension rewrites any still-current temporary checkpoint with `git commit --amend` into a normal project commit message supplied by the agent. If the agent supplied a checkpoint/post-review-loop message, the extension ignores it and falls back to a project-oriented message. If no start checkpoint exists but the loop applied code changes, it creates one normal project commit instead.
- The extension does not push commits. It refuses automatic commits during active merge/rebase states and skips final commit/amend work when validation failed or scope/context blocked safe completion.
- Bucket I history is append-only. Active/current views coalesce findings by normalized title because v1 has no stable finding id; treat that as a display approximation, not a durable identity model.
- Human reports are concise by default: summary, reviewed target, applied fixes, remaining decisions, validation outcome, and changed-file summary. `report --full` expands phase logs, complete validation rows, rejected/kept-as-is rationale, and full Bucket I/Bucket II detail.
- Human reports group current Bucket I findings by outcome: applied by the loop, still actionable / not yet applied, and rejected or downgraded. This keeps candidates and accepted-but-unfixed work visibly separate from applied fixes.
- Bucket I items can remain unfixed when the loop stops before implementation, such as review-only mode, iteration limit, validation/scope blockage, checkpoint failure, or an explicit user stop. Bucket I means “safe, in-scope, root-cause-fixable work,” not “already fixed.” Accepted Bucket I items should normally be fixed by the following `impl` phase; if they cannot be fixed, the report must show them as still actionable instead of clean.
- Bucket II decision items are coalesced by normalized title. Later materially changed submissions replace the current view; unchanged existing items should be omitted from new phase submissions.
- Bucket II gates count only unresolved decision statuses. Items marked `implemented after explicit approval` remain in reports but do not block a clean stop.
- Phase `summary` is a short human-friendly explanation of what code or behavior was reviewed/changed in that phase. It is not a file list or a findings list.
- `reviewTargetBriefing` drives the report's `What Was Reviewed` section. It explains the review target itself, such as uncommitted changes, a named feature implementation, or a refactor, in one or two teaching-style paragraphs instead of listing review activity by phase.
- `changedFiles` / `filesChanged` means files inspected, reviewed, or touched during submitted phases. `codeChanges` is the authoritative loop-edit ledger and drives “files edited by loop” wording in reports.
- Checkpoint compaction is internal to this extension. There is no separate model-facing phase compaction tool; models continue by submitting phase results, and the extension decides whether to compact and advance.
- Checkpoint compaction summaries are intentionally minimal. The extension persists the canonical ledger outside model context and injects the next authoritative phase prompt after compaction, so compaction should not duplicate Bucket details, validation rows, hash caches, or prior prompts.
- Compact phase prompts batch active Bucket I/Bucket II ledger items instead of dumping an unbounded list. Hidden overflow remains active in the persisted ledger and gate decisions count the merged current ledger, so omitted items are queued for later phases instead of being treated as resolved.
- Phase submissions record worktree fingerprints, per-file hashes for inspected files, and validation cache entries. Later prompts may cite still-current evidence or reused validation when hashes match, but changed files and uncertain command inputs still require fresh inspection/validation.
- Prompts encourage batching related Bucket I findings that share files, modules, or UI state domains before checkpointing. UI toolbar/button/readiness/action findings also get a generic state-combination checklist so related label/disabled/action cases are reviewed together.

## Workflow

```text
post-review -> impl-review -> impl -> post-review -> ... -> final-report
```

The extension is the source of truth for phase, iteration, status, ledger, checkpointing, and final report shape. The old skill should be treated as the prototype/spec, not a parallel maintained workflow.
