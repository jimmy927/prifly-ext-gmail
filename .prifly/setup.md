---
setup:
  - bun install --frozen-lockfile
---

A single bun package, with no workspaces and no build step. The install brings the dev tooling (biome,
TypeScript, `@types/bun`) and `@prifly/extension-api`, which provides types only and is imported
with `import type`. The gate is `bun test`, `bun run typecheck` (`tsc --noEmit`) and
`bun run check` (biome).

What it relies on outside the worktree:
- `bun` on PATH.
- SSH access to GitHub: `@prifly/extension-api` comes from
  `git+ssh://git@github.com/jimmy927/prifly-extension-api.git#v0.6.0`, a private repository, so
  the install needs a key that works for `git@github.com`.
