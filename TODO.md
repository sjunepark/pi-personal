# TODO

## Next

- Check t3 code and see if it has mobile support.

## Post-review-loop extension

- [ ] Treat validation failures as superseded when the same input fingerprint later passes.
  - Current symptom: the loop can stop with `validation is blocking safe continuation` even when the final report says validation passed after earlier failures.
  - Expected behavior: final gate/report should derive validation status from the latest relevant validation for the current fingerprint, not from any historical failed attempt.

- [ ] Make final reports reliably visible in API conversations.
  - Current symptom: the extension emits `post-review-loop-markdown` as a custom message with `display: true`, but API users may only see the tool result saying the report will render separately.
  - Expected behavior: expose the final report through a normal assistant-visible path, or provide an explicit retrieval/render action that the assistant can call.

- [ ] Mark the final-report render action complete after the markdown is emitted.
  - Current symptom: state can still report `requiredNextAction: Render or inspect the final report` after the report was already emitted.
  - Expected behavior: once the report is emitted, state should not keep prompting for the same render step unless rendering failed.
