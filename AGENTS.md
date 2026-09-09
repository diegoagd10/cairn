# Cairn

Cairn is a personal local tracker. Specs describe outcomes; tickets describe independently verifiable steps and their blockers.

Use `src/store.ts` as the shared domain boundary. CLI and HTTP changes use it. The UI may edit document titles, Markdown bodies, and status through same-origin, revision-checked endpoints; other edits use the CLI. Project data belongs in the user's data directory, outside Git. Resolve worktrees through their common Git directory and clones through a normalized remote.

For specs, tickets, dependencies, or progress, read `docs/agents/issue-tracker.md`. For agent integration changes, read `docs/integrations/matt-pocock.md`. Read commands and checks from `package.json` and `cairn --help`.

Test behavior at the store, CLI, or HTTP boundary, especially project isolation, dependency ordering, persistence, and unsafe Markdown. Preserve the original Markdown body during storage and export.

Install the repository's Git hooks with `pnpm hooks:install` (also run by dependency installation). Before committing, stage the intended changes; pre-commit runs `verify:deep` and `test:deployment` against an isolated copy of the index. Pre-push reruns `pnpm pr:check` for the current clean branch and commit and blocks publication on failure. Read the command output, fix the cause, stage the fix, and retry. Do not bypass hooks with `--no-verify`, disable them, or suppress failures.

Push the current non-default branch with `git push -u origin HEAD`, then create the PR with `pnpm pr:create` (for example, `pnpm pr:create --fill`). This requires a passing summary for the current clean branch and commit and checks the remote head. `pnpm pr:check` remains available for manual checks. Do not bypass this flow with direct `gh pr create` or the GitHub UI.
