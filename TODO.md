# TODO

## Next

- Build a path-scoped nested `AGENTS.md` extension for pi.
  - Scope by touched file path only; do not rely on branch names or worktree directory names.
  - Lazily discover `AGENTS.md` files from the repo root to the file/tool target path and inject newly relevant instructions before the next model turn.
  - Concatenate broad-to-local instructions, preserve file provenance, cache by mtime, and expose a command to inspect active instruction files.
  - Skip generated/noisy directories such as `.git`, `node_modules`, `.tmp`, `out`, and caches.
  - Defer imports, override files, and Claude-style path rules until the basic nested-loading behavior works.
- Check t3 code and see if it has mobile support.
