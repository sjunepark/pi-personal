# AGENTS.md

## Scope
- This repository is the source of truth for personal pi-specific resources.
- Keep reusable cross-harness skills in `custom-skills`, not here.
- Keep machine-local runtime state in `~/.pi/agent/`, not here.

## Layout
- Put pi extension source files in `extensions/`.
- Add new top-level resource directories only when they are actually used.
- Keep the package manifest minimal and aligned with the resources this repo exports.

## Safety
- Do not commit secrets, auth files, session history, caches, or machine-specific absolute paths.
- Keep configuration files that must stay at fixed pi runtime paths in chezmoi or `~/.pi/agent/`, not here.
