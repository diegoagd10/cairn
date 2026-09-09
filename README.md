# Cairn

**Personal specs and tickets for every repository.** Pronounced “kern.”

A quiet place for your development plans. Specs describe the destination; tickets mark the steps. Cairn keeps them in a local SQLite database, separate from your team's GitHub Issues, and gives your coding agent a JSON CLI and you a local web viewer with document editing.

## Start

Requires Node.js **24.14+** and Git. Tested on Node 24 and 26. SQLite is supplied by Node's `node:sqlite` module (experimental in Node 24; release candidate in Node 26).

```sh
npm ci
npm link
cairn project add .
cairn serve
```

Open **http://127.0.0.1:4317**. The viewer refreshes every 15 seconds while visible; use its refresh button for immediate updates. Stop the server with Ctrl+C. To run without a global link, use `node dist/cli.js` in place of `cairn`.

### Run automatically after a reboot

After the installation above, stop any manually running `cairn serve` with Ctrl+C, then run:

```sh
cairn service install
```

The same command works on **Linux with systemd, macOS, and Windows**. It installs the viewer for your current user, starts it in the background, and enables it to start whenever you log in, including after restarting the machine. No open terminal or coding agent is needed. Open **http://127.0.0.1:4317** as usual.

| System | Background manager | Installation |
| --- | --- | --- |
| Linux | systemd user service | `${XDG_CONFIG_HOME:-~/.config}/systemd/user/cairn.service` |
| macOS | launchd LaunchAgent | `~/Library/LaunchAgents/local.cairn.viewer.plist` |
| Windows | Task Scheduler, current user | Task `Cairn-<your Windows user SID>` in the root task folder |

Run installation from your normal user session. macOS requires a graphical login session. Windows requires Windows PowerShell 5.1 with the ScheduledTasks module (included in Windows 10/11); it registers an interactive task with limited privileges and does not save a password. If an organization restricts task registration, its administrator may need to allow it. These commands do not elevate privileges automatically.

```sh
cairn service status     # Show runtime state and whether startup is enabled
cairn service stop       # Stop now AND disable automatic startup
cairn service start      # Start now AND re-enable automatic startup
cairn service uninstall  # Stop and remove the service; keep your data
```

These commands work from any directory and do not require a registered project. There is one service per user, showing all projects in its database. `stop` keeps it off after the next reboot too; use `start` to resume. Uninstallation keeps the database and any log files. Each computer has its own local database; installing on several computers does not synchronize their projects.

Linux and macOS restart the viewer on failure. Windows retries three times at one-minute intervals, permits running on battery power, and has no execution time limit. Startup follows the native [launchd](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html) and [Task Scheduler](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasksettingsset) settings.

#### Starting before login

By default, all three platforms start at **login**, not before it. On Linux, to start at boot before logging in and keep running after logging out, enable lingering once:

```sh
loginctl enable-linger "$USER"
```

Your system may request administrator authentication. Lingering affects your entire user service manager, not just Cairn. To undo it, use `loginctl disable-linger "$USER"`; Cairn will then start at login when its service is enabled. Cairn does not enable lingering automatically. On macOS and Windows, these commands install only a login agent/task; starting before login is not implemented. Nothing runs while the machine is shut down or suspended.

#### Configuration and updates

For a different port or database:

```sh
cairn service install --port 4318 --db /absolute/path/to/cairn.sqlite
```

On Windows, use a Windows path, for example `cairn service install --port 4318 --db "C:\Users\Alice\Cairn Data\cairn.sqlite"`.

Installation saves the absolute paths to the current Node executable, Cairn CLI, and selected database. The database is selected using `--db`, then `CAIRN_DB`, then the normal XDG data directory. Relative database paths are resolved at installation time. Later changes to shell environment variables do not change the installed service. Re-running `install` replaces its settings and restarts it; pass your custom options again.

Keep the Cairn installation directory and Node executable available. `npm link` points at this checkout; it does not create an independent copy. After moving the installation or changing the Node executable location, run `npm link` and `cairn service install` again. After updating the source, run `npm run build`, then `cairn service stop` and `cairn service start` to load the new build without changing saved settings.

Installation does not change your repository. It refuses to overwrite a unit, plist, or task that was not created by Cairn.

#### Troubleshooting

Run `cairn service status`. An `active` value of `active` with `startup` set to `enabled` means the manager reports a running process and automatic startup is enabled. This is not an HTTP health check. Windows starts tasks asynchronously; an immediate status may show `Ready` or `Queued`, so check again after a moment. Windows also reports the native `lastExitCode` ([`267009`/`0x41301` means the task is currently running](https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-error-and-success-constants)).

| System | Logs |
| --- | --- |
| Linux | `journalctl --user -u cairn.service -n 50 --no-pager` |
| macOS | `~/Library/Logs/Cairn/viewer.log` and `viewer.error.log` |
| Windows | `%USERPROFILE%\.cairn\logs\viewer.log` and `viewer.error.log`; also inspect the task in Task Scheduler |

The macOS and Windows log files are appended and are not automatically rotated. If the viewer fails to start, check the logs for an occupied port, missing installation files, or database permissions. Stop any manually running viewer or install on another port. On Linux without systemd or another unsupported platform, use `cairn serve`.

### Use Cairn in another repository

For another repository:

```sh
cairn project add ~/Projects/another-repo
cd ~/Projects/another-repo
cairn spec create --title "Offline search" --body-file /tmp/spec.md
cairn ticket create --title "Search saved notes" --parent SPEC-ID --body-file /tmp/ticket.md
cairn next
cairn doc get TKT-ID
cairn comment add TKT-ID --body-file /tmp/verification.md
cairn doc status TKT-ID done
```

Replace placeholder IDs with the IDs returned by create commands. Use `--project NAME_OR_ID` when working outside a checkout. `cairn --help` lists all commands. Data commands emit JSON by default, even without `--json`; `doc export` emits Markdown. Operational errors use stderr and a nonzero exit status. Node 24 also prints its SQLite experimental warning to stderr; stdout remains machine-readable JSON.

## Connect your agent and Matt Pocock's skills

Use the [standalone setup guide](docs/integrations/matt-pocock.md) as the reference for `setup-matt-pocock-skills`. It includes a ready-to-use setup prompt and the complete tracker workflow; **the Cairn skill is optional**.

1. Install the Cairn CLI and register the target repository with `cairn project add .`.
2. Run Matt's setup in that repository, choose **Other**, and provide the guide. Have setup copy its tracker instructions into the destination's `docs/agents/issue-tracker.md` so agents do not depend on a path to your Cairn checkout.
3. Ensure the repository's `AGENTS.md` or `CLAUDE.md` links to those instructions. The guide includes checks to verify the setup. Registering a repository in Cairn does not edit its agent instructions automatically.

For agents that use standalone skills, the bundled [Cairn skill](skills/cairn/SKILL.md) remains an optional alternative. Install it in your agent's supported skill location; it is not required by Matt's tracker configuration. The CLI works without running the web viewer or installing the background service.

The current upstream [`to-spec`](https://github.com/mattpocock/skills/blob/main/skills/engineering/to-spec/SKILL.md) and [`to-tickets`](https://github.com/mattpocock/skills/blob/main/skills/engineering/to-tickets/SKILL.md) read the configured tracker. Their synthesis, templates, and review steps stay with those skills; Cairn supplies storage and relationships. If using older skills that explicitly require GitHub, update or adapt that tracker instruction first.

Compatibility is through the configured tracker contract, with tested CLI operations. This release does not bundle or modify Matt Pocock's skills, and an automated end-to-end LLM run of those upstream skills is not part of the test suite.

## What v0.1 includes

- Repository registration, stable document IDs, specs, tickets, Markdown bodies, and comments.
- Spec-to-ticket relationships and a dependency graph that rejects cycles and cross-project references.
- Two lifecycle statuses: `ready-for-agent` and `done`. A blocked ticket cannot finish. Parent specs close explicitly after all their tickets are done. Legacy labels remain stored as metadata.
- Ready-ticket discovery, revision checks for document edits, JSON project export, original Markdown export, and SQLite backup.
- A responsive viewer with persistent desktop repository navigation, a collapsible mobile sidebar, saved light/dark preference, a unified specs-and-tickets list, search and filters, progress, Markdown, notes, relationships, and Markdown downloads. Documents open across the full content width and support title, Markdown, and status edits.
- Common Git directory resolution for worktrees and normalized `origin` identity for separate clones. Remote credentials are not stored. Re-register after changing `origin`; renames can require explicit project selection when identities conflict.

The CLI is the agent interface in v0.1. MCP and a TUI are future extensions of the same store, not implemented interfaces. This is a personal, single-machine tool: there is no cloud sync, authentication service, GitHub Issues sync, or atomic multi-agent work claiming. Text search currently covers titles and IDs. Marking a ticket done records your/your agent's verification; Cairn does not execute or judge acceptance criteria.

## Data and backup

Default database: `${XDG_DATA_HOME:-~/.local/share}/cairn/cairn.sqlite`. Override with `CAIRN_DB` or `--db PATH`. The database and its journal stay outside the code repositories. For a demo or test, use a separate `--db` path.

```sh
cairn export --project cairn --output /path/to/cairn-export.json
cairn backup --output /path/to/cairn-backup.sqlite
cairn --db /path/to/cairn-backup.sqlite project list
```

Both file-writing commands refuse to overwrite existing files. The SQLite backup API captures a consistent database including WAL changes. Store backups somewhere safe; local does not mean backed up. JSON is a portable archive; importing JSON is not implemented. To restore, stop running Cairn processes and launch with `--db` pointing at a copy of your SQLite backup.

The viewer binds to `127.0.0.1` and checks Host and Origin. Reads use GET; title, Markdown, and status edits use same-origin JSON POST requests with revision checks. Conflicting edits preserve the draft for review. Markdown is sanitized, external images are omitted, and a restrictive content security policy is applied. Other processes running as your local user can still access your data. Keep the server on loopback.

Existing v1 databases migrate automatically to the two-status schema. Done documents stay done; other statuses become ready-for-agent. A done spec with unfinished tickets reopens. Markdown, relationships, labels, and comments are preserved. Back up before upgrading; older Cairn versions cannot open the migrated database.

## Development

```sh
pnpm install --frozen-lockfile
pnpm verify:deep
pnpm test:deployment
pnpm dev
```

The development server relaxes only the inline-style part of the content security policy so Codex browser annotations can draw their review overlay. Installed and background viewers keep the stricter production policy.

Use the pnpm version pinned in `package.json`. When changing dependencies, update both `pnpm-lock.yaml` and `package-lock.json` so the npm installation instructions remain reproducible.

`src/store.ts` owns persistence and domain rules, `src/repo.ts` resolves repository identity, `src/cli.ts` handles agent commands, and `src/server.ts` serves the viewer in `web/`. Runtime dependencies are limited to Markdown parsing and HTML sanitization. Tests use temporary repositories and databases and exercise behavior across the store, CLI, and HTTP boundaries.

`verify:deep` runs TypeScript checking, the full test suite, and the build. `test:deployment` builds and checks an isolated installation containing the compiled application, web assets, and production dependencies installed from the frozen pnpm lockfile. It exercises the compiled CLI, SQLite persistence, HTTP assets, and sanitized Markdown without using the user's database or installing a background service.

Checks run locally on the current Node version and OS. Service tests isolate manager changes; on macOS they validate the generated plist with `plutil`, and on Windows they execute PowerShell and native task object constructors with scheduler reads/writes replaced. They do not perform real installation, reboot, or login tests. Local checks do not reproduce the previous GitHub Actions matrix across Node versions and operating systems.

### Before creating a PR

GitHub Actions have been removed. Dependency installation enables the versioned hooks via `core.hooksPath=.githooks`; run `pnpm hooks:install` to enable them in an existing checkout or after installing with lifecycle scripts disabled. Installation preserves existing custom hooks by refusing to replace them. Git configuration is local to the clone and shared by its worktrees; each checkout needs the versioned `.githooks` files.

On a feature branch:

```sh
git add <files>
git commit -m "Describe the change"
git push -u origin HEAD
pnpm pr:create --fill
```

`pre-commit` exports the exact staged index to a temporary repository, installs dependencies with the frozen lockfile and lifecycle scripts disabled, and runs `verify:deep` and `test:deployment`. Unstaged and untracked files stay untouched; unstaged fixes cannot hide broken staged code. This also handles the temporary index used by `git commit --only`. A failure rejects the commit and streams the failing command's output to the caller, including coding agents. The temporary directory is removed afterwards. These checks may take time because both suites run on every commit.

`pre-push` reruns `pnpm pr:check` and rejects the push if it fails. It checks the ref updates Git actually intends to send and only permits publishing the current commit to the same branch on `origin`, one branch per push. Other branches, renamed destinations, and tags are rejected. Ref deletions do not publish code and skip checks. The resulting summary is associated with the commit SHA; a pre-commit check alone cannot create that approval because the commit does not exist yet.

On failure, read the output, fix the code, stage the correction, and retry the commit or push. Agents must not use `--no-verify` or disable the hooks to get past a failure.

`pr:check` requires a clean checkout, rejects detached HEAD and `main`, `master`, or the known `origin/HEAD` default branch, and prints the branch and full commit SHA. It runs `verify:deep` followed by `test:deployment`, stopping on failure, and checks that the branch, commit, origin, and clean state still match after each command.

The JSON summary is stored at `<common Git directory>/cairn/pr-checks/<commit SHA>.json`, outside versioned files and shared by worktrees. It records the branch, SHA, origin, Node version, OS, timestamps, command exit codes, durations, and overall result. A rerun invalidates the previous result before starting; failed or interrupted checks cannot authorize a PR.

`pr:create` requires a passing summary for the current clean branch and commit and verifies that the branch on `origin` points to that exact SHA before invoking GitHub CLI. It needs an authenticated `gh` installation and access to the remote. A new commit, amended commit, different branch, or changed origin requires another `pr:check`; an unpublished commit must be pushed first. The command does not push automatically.

Supported PR options are `--title`, `--body`, `--body-file`, `--base`, `--draft`, `--fill`, `--fill-first`, and `--fill-verbose`. Pass them directly, for example `pnpm pr:create --title "Fix viewer" --body-file /tmp/pr.md`. The head branch and repository are fixed by the checked state.

This is a local workflow gate. Git hooks can be disabled and direct use of GitHub or `gh pr create` can bypass PR creation checks; the repository's agent instructions prohibit those bypasses. It does not provide a GitHub branch-protection rule. Later commits pushed to an existing PR run the pre-push checks again.
