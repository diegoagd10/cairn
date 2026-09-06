# Cairn

**Personal specs and tickets for every repository.** Pronounced “kern.”

A quiet place for your development plans. Specs describe the destination; tickets mark the steps. Cairn keeps them in a local SQLite database, separate from your team's GitHub Issues, and gives your coding agent a JSON CLI and you a read-only web viewer.

## Start

Requires Node.js **24.14+** and Git. Tested on Node 24 and 26. SQLite is supplied by Node's `node:sqlite` module (experimental in Node 24; release candidate in Node 26).

```sh
npm ci
npm link
cairn project add .
cairn serve
```

Open **http://127.0.0.1:4317**. The viewer refreshes every 15 seconds while visible; use its refresh button for immediate updates. Stop the server with Ctrl+C. To run without a global link, use `node dist/cli.js` in place of `cairn`.

For another repository:

```sh
cairn project add ~/Projects/another-repo
cd ~/Projects/another-repo
cairn spec create --title "Offline search" --body-file /tmp/spec.md
cairn ticket create --title "Search saved notes" --parent SPEC-ID --body-file /tmp/ticket.md
cairn next
cairn doc get TKT-ID
cairn doc status TKT-ID in-progress
cairn comment add TKT-ID --body-file /tmp/verification.md
cairn doc status TKT-ID done
```

Replace placeholder IDs with the IDs returned by create commands. Use `--project NAME_OR_ID` when working outside a checkout. `cairn --help` lists all commands. Data commands emit JSON by default, even without `--json`; `doc export` emits Markdown. Operational errors use stderr and a nonzero exit status. Node 24 also prints its SQLite experimental warning to stderr; stdout remains machine-readable JSON.

## Connect your agent and Matt Pocock's skills

1. Install the bundled `skills/cairn` directory in your agent's skills location. For Codex, link or copy it to `~/.codex/skills/cairn`. Reload the agent session to discover newly installed skills.
2. In a repository's Matt Pocock setup, choose **Other** as the tracker. Describe Cairn's CLI workflow using [the tracker instructions](docs/agents/issue-tracker.md) and [the skill](skills/cairn/SKILL.md).
3. Ensure the repository's `AGENTS.md` or `CLAUDE.md` points to its tracker instructions. Apply this per repository; registering a repository in Cairn does not edit its agent instructions automatically.

The current upstream [`to-spec`](https://github.com/mattpocock/skills/blob/main/skills/engineering/to-spec/SKILL.md) and [`to-tickets`](https://github.com/mattpocock/skills/blob/main/skills/engineering/to-tickets/SKILL.md) read the configured tracker. Their synthesis, templates, and review steps stay with those skills; Cairn supplies storage and relationships. If using older skills that explicitly require GitHub, update or adapt that tracker instruction first.

Compatibility is through the configured tracker contract, with tested CLI operations. This release does not bundle or modify Matt Pocock's skills, and an automated end-to-end LLM run of those upstream skills is not part of the test suite.

## What v0.1 includes

- Repository registration, stable document IDs, specs, tickets, Markdown bodies, and comments.
- Spec-to-ticket relationships and a dependency graph that rejects cycles and cross-project references.
- Lifecycle statuses plus separate triage labels. A blocked ticket cannot start or finish. Parent specs close explicitly after their tickets reach terminal states.
- Ready-ticket discovery, revision checks for document edits, JSON project export, original Markdown export, and SQLite backup.
- A responsive viewer with project navigation, search by title/ID, status filters, progress, Markdown, notes, relationships, and Markdown downloads.
- Common Git directory resolution for worktrees and normalized `origin` identity for separate clones. Remote credentials are not stored. Re-register after changing `origin`; renames can require explicit project selection when identities conflict.

The CLI is the agent interface in v0.1. MCP and a TUI are future extensions of the same store, not implemented interfaces. This is a personal, single-machine tool: there is no cloud sync, authentication service, GitHub Issues sync, browser editing, or atomic multi-agent work claiming. Text search currently covers titles and IDs. Marking a ticket done records your/your agent's verification; Cairn does not execute or judge acceptance criteria.

## Data and backup

Default database: `${XDG_DATA_HOME:-~/.local/share}/cairn/cairn.sqlite`. Override with `CAIRN_DB` or `--db PATH`. The database and its journal stay outside the code repositories. For a demo or test, use a separate `--db` path.

```sh
cairn export --project cairn --output /path/to/cairn-export.json
cairn backup --output /path/to/cairn-backup.sqlite
cairn --db /path/to/cairn-backup.sqlite project list
```

Both file-writing commands refuse to overwrite existing files. The SQLite backup API captures a consistent database including WAL changes. Store backups somewhere safe; local does not mean backed up. JSON is a portable archive; importing JSON is not implemented. To restore, stop running Cairn processes and launch with `--db` pointing at a copy of your SQLite backup.

The viewer binds to `127.0.0.1`, checks Host and Origin, and exposes only GET routes. Markdown is sanitized, external images are omitted, and a restrictive content security policy is applied. Other processes running as your local user can still access your data. Keep the server on loopback.

## Development

```sh
npm run check
npm test
npm run build
npm run dev
```

`src/store.ts` owns persistence and domain rules, `src/repo.ts` resolves repository identity, `src/cli.ts` handles agent commands, and `src/server.ts` serves the viewer in `web/`. Runtime dependencies are limited to Markdown parsing and HTML sanitization. Tests use temporary repositories and databases and exercise behavior across the store, CLI, and HTTP boundaries. CI runs on Node 24 and 26.
