# Configure Matt Pocock's skills to use Cairn

Use this guide as the reference for `setup-matt-pocock-skills` when choosing **Other** as the issue tracker. It contains the complete Cairn workflow; installing the Cairn skill is optional. Matt's skills supply the planning, ticket templates, review, and implementation workflow. Cairn supplies local storage, document IDs, dependencies, and progress.

## Prerequisites

Install Node.js 24.14+ and Git. From a checkout of Cairn, run:

```sh
npm ci
npm link
cairn --help
```

Install Matt's engineering skills separately using the instructions in [Matt Pocock's skills repository](https://github.com/mattpocock/skills). Cairn does not bundle or install them.

Then, from the repository you want to track, run:

```sh
cairn project add .
cairn project resolve
```

The agent needs access to the `cairn` command and the local database. The web viewer and background service are optional; the CLI accesses the database directly. On another computer, install Cairn and register the repository there too. Data is local to each computer and is not synchronized by Git.

## Give this reference to setup

Run `setup-matt-pocock-skills` in the target repository and provide this prompt, replacing the guide path with the actual path to your Cairn checkout:

```text
Use Cairn as this repository's issue tracker (Other).
Read /absolute/path/to/cairn/docs/integrations/matt-pocock.md.
Use its "Tracker instructions to copy" section to write a self-contained
docs/agents/issue-tracker.md in this repository. Link that file from the
existing AGENTS.md or CLAUDE.md using your normal setup workflow.
Do not require installation of the Cairn skill or leave a dependency on
the path to my Cairn checkout. Preserve existing project instructions
and your normal review steps, triage setup, and domain documentation setup.
```

On Windows, provide a Windows path to this guide. You can also attach the guide or provide its contents if the agent cannot read the Cairn checkout. Do not copy machine-specific absolute paths into the destination repository's instructions.

The setup skill records the tracker workflow in `docs/agents/issue-tracker.md` and links it from the repository's agent instructions. Merely running `cairn project add` or `cairn service install` does not perform that setup.

## Tracker instructions to copy

Copy this section's contents into the target repository's `docs/agents/issue-tracker.md`. The following instructions are sufficient without a separate Cairn skill.

### Tracker and project selection

This repository uses **Cairn** for specs, tickets, blocking dependencies, comments, and progress. Use the `cairn` CLI. Planning documents live in its local SQLite database outside Git; the repository's Git remote remains the source-code host.

Before working with documents, run:

```sh
cairn --help
cairn project resolve
```

Resolve from the target repository's checkout, not from the Cairn installation directory. If the repository has not been registered, set it up with `cairn project add .` as part of the user's requested tracker setup. Outside a checkout, use `cairn project list` to find the intended project, then pass `--project PROJECT-ID-OR-NAME` to document commands. Prefer the returned project ID when names are ambiguous. Never substitute an ID from another project.

The normal database location is the user's XDG data directory under `cairn/cairn.sqlite`, falling back to `~/.local/share/cairn/cairn.sqlite`. If using a custom database, use the same `CAIRN_DB` or `--db PATH` consistently for registration and subsequent commands. Do not put the database in Git.

Data commands return JSON. Operational errors go to stderr with a nonzero exit status; stop dependent operations and resolve the error before continuing. Node may also emit a SQLite warning on stderr, so inspect the exit status and keep stdout separate. `cairn doc export` returns original Markdown rather than JSON.

### Publish specs and tickets

Keep the active planning skill's templates and review steps. Write each complete Markdown body to a UTF-8 file, preferably a temporary file outside Git, then pass it using `--body-file`. Do not interpolate Markdown into shell commands. Cairn stores and exports the body unchanged.

```sh
cairn spec create --title "Offline search" --body-file "path/to/spec.md"
cairn ticket create --title "Index saved notes" --body-file "path/to/index-ticket.md" --parent SPEC-ID
cairn ticket create --title "Search saved notes" --body-file "path/to/search-ticket.md" --parent SPEC-ID --blocked-by FIRST-TICKET-ID
```

Replace the example paths with files you have written, and the placeholder IDs with IDs returned by earlier commands. For `to-spec`, publish one spec. For `to-tickets`, publish one ticket per approved slice. If the source is an existing spec, use its ID as `--parent` on each ticket; otherwise omit `--parent`. Do not pass a ticket ID as a spec parent.

Publish blockers first so dependent tickets can reference their real IDs. Use `--blocked-by ID,ID` for structured dependencies, even when the Markdown also describes them. Creating tickets does not close or change the parent spec. A multi-command publication can partially succeed: inspect existing documents before retrying to avoid duplicates.

After publication, read back each document with `cairn doc get ID`. Verify its Markdown, parent, and blockers against the approved plan, then report the returned IDs.

### Read, update, and export

```sh
cairn spec list
cairn ticket list
cairn doc get ID
cairn doc update ID --body-file "path/to/revised.md" --revision REVISION
cairn doc update TICKET-ID --blocked-by BLOCKER-ID,OTHER-BLOCKER-ID --revision REVISION
cairn comment add ID --body-file "path/to/note.md"
cairn doc export ID
cairn export
```

`doc get` includes the body, comments, relationships, and current revision. Before editing a document, read it and pass the returned revision to `doc update`; on a conflict, read again and reconcile. The `--blocked-by` list replaces all blockers rather than appending. Use `--blocked-by ""` to clear them with a shell that preserves empty arguments; Windows PowerShell 5.1 users can use `--blocked-by=,`, which Cairn also parses as an empty list. Omit `--blocked-by` to leave dependencies unchanged.

### Triage and implementation

Triage labels and lifecycle statuses are separate. Use the project's configured label vocabulary. Cairn's default roles are `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. Set a document's label with `--label` on creation or `cairn doc update ID --label LABEL`. New documents default to `ready-for-agent`.

```sh
cairn next
cairn doc get TICKET-ID
cairn doc status TICKET-ID in-progress
cairn comment add TICKET-ID --body-file "path/to/verification.md"
cairn doc status TICKET-ID done
```

`cairn next` returns only `todo` tickets labelled exactly `ready-for-agent` whose blockers are all done. If the project uses a different readiness label, use `ticket list` and inspect statuses and blockers explicitly. Read the selected ticket, its comments, and its parent spec before implementing it.

Lifecycle statuses are `todo`, `in-progress`, `done`, and `cancelled`. A blocked ticket cannot start or finish. A cancelled blocker remains unresolved until its dependency is removed or the blocker is completed. Changing a triage label to `wontfix` does not cancel a ticket; change the lifecycle status explicitly when appropriate.

Verify the ticket's acceptance criteria, record the evidence in a comment, then mark it done. Cairn enforces dependency rules but does not run tests or judge acceptance criteria. Close a parent spec explicitly only after checking its overall outcome and after all its tickets are done or cancelled.

For parallel agents, assign distinct tickets explicitly and give each agent its project and ticket IDs. `cairn next` lists available work; it does not atomically claim or assign it. Agents on the same computer must use the same database. Worktrees of a registered repository can resolve to the same project; registering a separate clone can associate it through a normalized remote.

## Verify the setup

From the target repository, run `cairn project resolve`, `cairn spec list`, `cairn ticket list`, and `cairn next`. Empty lists are valid; no sample tickets are needed. Confirm that the agent instructions link to the destination's tracker document and that the document contains the workflow above without requiring the Cairn skill or an absolute link to your Cairn checkout.

For an agent-level check, ask: "Without creating or changing any documents, explain which tracker this repository uses and how you would publish a spec, create dependent tickets, and find the next ready ticket." The answer should use Cairn's CLI and the intended project.

This setup integrates through written tracker instructions. It does not install or modify Matt's skills, add an MCP server, or configure a background agent to work automatically.

## Upstream references

- [setup-matt-pocock-skills](https://github.com/mattpocock/skills/blob/main/skills/engineering/setup-matt-pocock-skills/SKILL.md) records the selected tracker and accepts a described workflow for Other.
- [to-spec](https://github.com/mattpocock/skills/blob/main/skills/engineering/to-spec/SKILL.md) publishes a spec to the configured tracker.
- [to-tickets](https://github.com/mattpocock/skills/blob/main/skills/engineering/to-tickets/SKILL.md) publishes approved tickets with blocking relationships.

Older versions that hard-code GitHub need to be updated or adapted to read the configured tracker. Cairn's CLI boundaries are tested; an automated end-to-end run of Matt's agent skills is not part of Cairn's test suite.
