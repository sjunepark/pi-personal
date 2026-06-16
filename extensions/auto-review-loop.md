# auto-review-loop

Ledger-driven autonomous code review for Pi. The loop reviews one repository slice at a time, applies only tiny obvious fixes, runs `post-review-loop` after any edit, asks for design/refactor decisions, and records review history in `reviews/auto-review/`.

## Basic use

```text
/auto-review once
/auto-review start
/auto-review status
/auto-review pause
/auto-review resume
/auto-review stop
```

Useful options:

```text
/auto-review start --once
/auto-review start --review-limit 3
/auto-review start --dimensions correctness,structure,docs
```

When the loop is waiting for a decision, answer normally or explicitly:

```text
/auto-review answer <decision>
```

## Workflow contract

1. The extension selects one review slice from configured area × dimension cells.
2. The model reviews real files for that slice and reports with `auto_review_result`; slices with no matching files are recorded complete and the loop continues.
3. The model may auto-fix only tiny obvious local issues with no design, schema, public contract, lifecycle, ownership, or taste decision.
4. Larger design/refactor findings pause the loop and ask for a user decision.
5. If files changed, the extension starts `post-review-loop` programmatically.
6. The loop waits for the tracked `post-review-loop` to become complete. It ignores unrelated review-loop states.
7. If self-review leaves unresolved Bucket II items or actionable Bucket I items, auto-review asks the user before continuing.
8. If self-review is clean, the slice is recorded complete and the next slice starts unless `--once` or the review limit stops the loop.

## Ledger

Runtime ledger files are written under:

```text
reviews/auto-review/
  state.json
  ledger.jsonl
  decisions.md
```

Session entries remain the authoritative live state for Pi restore. The repo-local files are for review history, portability, and later branch-aware staleness detection. Ledger writes are best-effort: a file write failure should not stop an active Pi workflow.

## Phone / Remote Pi behavior

The loop is designed for plain chat replies, which works with Remote Pi mobile input. Prompts are short and decision-oriented, with numbered choices when practical. For sensitive repositories, avoid the public Remote Pi relay unless its security model changes; current protocol notes say relay operators can see message contents, so prefer a self-hosted relay behind Tailscale/WireGuard.

## Current limitations

- Area selection currently uses built-in defaults for plan files, extension files, tests, and repository config.
- Stale detection is session/ledger-oriented but does not yet compare file fingerprints to revive changed cells.
- Branch freshness checks currently inspect only the configured upstream at safe checkpoints. They can prompt to continue, pause, or ask the agent to handle an explicitly approved sync, but merge/rebase automation is intentionally conservative.
- Auto-commit policy is delegated to `post-review-loop` final selective commit behavior after fixes.
