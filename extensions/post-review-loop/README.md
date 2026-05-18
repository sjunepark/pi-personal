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

Alias:

```text
/pr-loop ...
```

## Model tools

- `post_review_loop_get_state`
- `post_review_loop_submit_phase_result`
- `post_review_loop_abort`

The model supplies phase findings, validation, and code-change facts. The extension persists the ledger, gates phase transitions, handles checkpoint compaction, and renders the final report.

## Workflow

```text
post-review -> impl-review -> impl -> post-review -> ... -> final-report
```

The extension is the source of truth for phase, iteration, status, ledger, checkpointing, and final report shape. The old skill should be treated as the prototype/spec, not a parallel maintained workflow.
