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
cairn doc status TKT-ID in-progress
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

`src/store.ts` owns persistence and domain rules, `src/repo.ts` resolves repository identity, `src/cli.ts` handles agent commands, and `src/server.ts` serves the viewer in `web/`. Runtime dependencies are limited to Markdown parsing and HTML sanitization. Tests use temporary repositories and databases and exercise behavior across the store, CLI, and HTTP boundaries. CI runs the full suite on Linux with Node 24 and 26, plus service tests on macOS and Windows with Node 24. Service tests isolate manager changes; macOS validates the generated plist with `plutil`, and Windows executes PowerShell and native task object constructors with scheduler reads/writes replaced. They do not perform real installation, reboot, or login tests.
