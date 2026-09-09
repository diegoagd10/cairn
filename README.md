# Cairn

Personal specs and tickets for your Git repositories. Specs describe outcomes; tickets track the steps and their blockers. Everything lives in a local SQLite database outside Git.

Use the CLI yourself or through a coding agent. The local web viewer lets you browse projects and edit document titles, Markdown, and status. Creation, comments, and dependency changes use the CLI. Data stays on this computer; there is no cloud or GitHub Issues sync.

## Start

Requires Node.js **24.14+** and Git. From a checkout of Cairn:

```sh
npm ci
npm link
```

Then, from the repository you want to track:

```sh
cairn project add .
cairn serve
```

Open [127.0.0.1:4317](http://127.0.0.1:4317). The viewer runs in the foreground; stop it with Ctrl+C. The CLI works without the viewer running.

`npm link` points to this Cairn checkout, so keep it available. Without a global link, use `node /path/to/cairn/dist/cli.js` instead of `cairn`.

## Track work

Write your spec and ticket bodies in Markdown files, then run:

```sh
cairn spec create --title "Offline search" --body-file /path/to/spec.md
cairn ticket create --title "Search saved notes" --parent SPEC-ID --body-file /path/to/ticket.md
cairn next
cairn doc get TKT-ID
cairn comment add TKT-ID --body-file /path/to/verification.md
cairn doc status TKT-ID done
cairn doc status SPEC-ID done
```

Replace paths with your files and placeholder IDs with the IDs returned by creation commands.

- Documents have two statuses: `ready-for-agent` and `done`.
- Add ticket dependencies with `--blocked-by TKT-ID,TKT-ID`. `cairn next` lists unfinished tickets whose blockers are complete.
- Blocked tickets cannot finish. Mark a spec done explicitly after completing all its tickets.
- Commands resolve the current repository. Outside a checkout, pass `--project NAME_OR_ID`. Worktrees share project identity; clones with the same normalized `origin` resolve to the same project in the database.

Run `cairn --help` for all commands. Data commands return JSON; `cairn doc export ID` returns the original Markdown.

For agent setup, follow the [Matt Pocock integration guide](docs/integrations/matt-pocock.md). Registering a project does not configure its agent instructions.

## Data and backups

Default database: `${XDG_DATA_HOME:-~/.local/share}/cairn/cairn.sqlite`. Override with `CAIRN_DB` or `--db PATH`.

```sh
cairn backup --output /path/to/backup.sqlite
cairn export --output /path/to/project.json
```

Both commands refuse to overwrite files. The SQLite backup includes all projects; JSON export includes the selected project. To restore, stop Cairn processes and use `--db` pointing to a copy of the SQLite backup. JSON import is not implemented.

## Development

Use the pnpm version pinned in `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm verify:deep
pnpm test:deployment
pnpm dev
```

`verify:deep` runs type checks, tests, and the build. `test:deployment` checks an isolated production installation. Keep both lockfiles updated when changing dependencies.

Dependency installation enables Git hooks; use `pnpm hooks:install` for an existing installation. Pre-commit checks staged changes; pre-push checks the current clean branch and commit. Fix failures and retry without bypassing hooks.

To publish from a non-default branch, stage and commit your changes, then run:

```sh
git push -u origin HEAD
pnpm pr:create --fill
```

PR creation requires the passing checks and matching remote commit. See [AGENTS.md](AGENTS.md) for repository conventions.
