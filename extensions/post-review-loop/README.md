# post-review-loop

Pi extension that owns the post-implementation review loop workflow.

## Commands

```text
/post-review-loop start [--limit N] [--review-only] <scope>
/post-review-loop status
/post-review-loop pause
/post-review-loop resume
/post-review-loop stop
/post-review-loop report
/post-review-loop clear
```

## Model tools

- `post_review_loop_get_state`
- `post_review_loop_submit_phase_result`
- `post_review_loop_abort`

The model supplies phase findings, validation, submitted phase-scope files, and code-change facts. The extension persists the ledger, gates phase transitions, owns checkpoint compaction internally, and renders the final report.

## Current v1 policies

- Git integration is record-only. The extension records the starting `HEAD`, dirty files, and after-review state, but it does not stage, create, amend, or push commits.
- Loop-owned commit automation is deferred until an explicit policy is designed for staging scope, loop-owned markers, amend behavior, and dirty-worktree refusal cases.
- Bucket I history is append-only. Active/current views coalesce findings by normalized title because v1 has no stable finding id; treat that as a display approximation, not a durable identity model.
- Bucket II decision items are coalesced by normalized title. Later materially changed submissions replace the current view; unchanged existing items should be omitted from new phase submissions.
- Bucket II gates count only unresolved decision statuses. Items marked `implemented after explicit approval` remain in reports but do not block a clean stop.
- Phase `summary` is a short human-friendly explanation of what code or behavior was reviewed/changed. It is not a file list or a findings list.
- `changedFiles` / `filesChanged` means files inspected, reviewed, or touched during submitted phases. `codeChanges` is the authoritative loop-edit ledger and drives “files edited by loop” wording in reports.
- Checkpoint compaction is internal to this extension. There is no separate model-facing phase compaction tool; models continue by submitting phase results, and the extension decides whether to compact and advance.

## Workflow

```text
post-review -> impl-review -> impl -> post-review -> ... -> final-report
```

The extension is the source of truth for phase, iteration, status, ledger, checkpointing, and final report shape. The old skill should be treated as the prototype/spec, not a parallel maintained workflow.
