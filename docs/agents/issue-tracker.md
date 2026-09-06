# Issue tracker

This repository uses **Cairn**, the personal local tracker, for specs, tickets, blockers, progress, and implementation notes. GitHub hosts source code. Planning documents live in the local Cairn database.

Read the [tracker workflow in the integration guide](../integrations/matt-pocock.md#tracker-instructions-to-copy) before publishing a spec, converting a spec into tickets, reading a ticket's context, or updating progress. It is self-contained; installing the Cairn skill is optional. Resolve this repository with `cairn project resolve`. If the CLI is not installed yet, build it and invoke `node dist/cli.js` from this checkout.

For Matt Pocock's `/setup-matt-pocock-skills`, this is an **Other** issue tracker. `/to-spec` publishes a Cairn spec. `/to-tickets` publishes Cairn tickets with a spec parent and structured blocking edges. Retain those skills' document templates and review process.

The default label vocabulary is in `triage-labels.md`. Lifecycle states (`todo`, `in-progress`, `done`, `cancelled`) are independent of labels. A cancelled blocker remains unresolved until its edge is explicitly removed or the blocker is completed.
