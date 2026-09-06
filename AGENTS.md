# Cairn

Cairn is a personal local tracker. Specs describe outcomes; tickets describe independently verifiable steps and their blockers.

Use `src/store.ts` as the shared domain boundary. CLI and viewer use it; keep writes out of the viewer. Project data belongs in the user's data directory, outside Git. Resolve worktrees through their common Git directory and clones through a normalized remote.

For specs, tickets, dependencies, or progress, read `docs/agents/issue-tracker.md`. For agent integration changes, read `skills/cairn/SKILL.md`. Read commands and checks from `package.json` and `cairn --help`.

Test behavior at the store, CLI, or HTTP boundary, especially project isolation, dependency ordering, persistence, and unsafe Markdown. Preserve the original Markdown body during storage and export.
