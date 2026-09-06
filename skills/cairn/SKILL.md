---
name: cairn
description: Use Cairn to publish or read specs and tickets, manage blockers, add notes, or find the next ready ticket in repositories configured to use Cairn as their issue tracker. Integrates with Matt Pocock's to-spec and to-tickets workflows.
---

# Cairn tracker

## Resolve the project

Read the repository's issue-tracker instructions before choosing a tracker. When Cairn is configured, run `cairn project resolve` from the repository. For a session outside the checkout, use `cairn project list`, choose the matching project, and pass its ID with `--project` to subsequent commands. Register a repository with `cairn project add` when the user asks to set it up. A project reference is required for every document operation; an ID from another project is rejected.

Run `cairn --help` for command syntax. Data commands emit JSON. An error exits nonzero with JSON on stderr. Stop dependent operations on failure and resolve the reported cause.

## Publish a spec or ticket breakdown

Keep the upstream skill's synthesis, templates, review steps, and approval requirements. Substitute Cairn for its configured tracker operations. The command-line examples below describe commands that exist; Cairn has no MCP server in v0.1.

Write the complete Markdown body to a temporary file, then use `cairn spec create --title TEXT --body-file PATH` or `cairn ticket create --title TEXT --body-file PATH`. A body file avoids shell interpolation of Markdown. Use the returned ID as the durable reference and report it to the user.

For a breakdown from an existing spec, pass `--parent SPEC-ID` on each ticket. Publish blockers first, collect their returned IDs, then pass `--blocked-by ID,ID` on dependent tickets. Keep the original acceptance criteria in the body. Blockers are structured relationships; set them with the flag even if the Markdown also names them. Publish one document per ticket. A batch can partially succeed: inspect existing tickets before retrying to avoid duplicates.

New documents have `ready-for-agent` status. Legacy labels remain metadata and do not affect readiness. Creating tickets leaves the parent spec unchanged. Read back the created documents and verify each parent, body, and blocker against the approved breakdown before reporting publication complete. Store planning documents in Cairn; GitHub remains the code remote.

## Read and implement

Use `cairn doc get ID` to read the full body, comments, status, revision, and blockers. Use `cairn next` for tickets with `ready-for-agent` status and no unfinished blockers. Read the parent spec and selected ticket before implementation. `next` lists candidates; it does not claim work atomically.

Keep the ticket `ready-for-agent` during implementation. Complete implementation and verify its acceptance criteria, then record useful evidence with `cairn comment add ID --body-file PATH` and mark it `done`. Cairn enforces dependency completion; the agent verifies the acceptance criteria. Close a spec explicitly only after checking its overall outcome.

## Revise documents

Use `cairn doc update ID` with a fresh body file or title and the `--revision` returned by the latest read. On a revision conflict, read again and reconcile before retrying. Replace dependencies with `--blocked-by ID,ID`; clear them with `--blocked-by ""`. The dependency list replaces the entire previous list.

Use `cairn doc export ID` to retrieve the exact original Markdown. `cairn export` includes all project documents, comments, statuses, and relationships as JSON.
