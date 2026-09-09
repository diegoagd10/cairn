# Issue tracker

This repository uses **Cairn**, the personal local tracker, for specs, tickets, blockers, progress, and implementation notes. GitHub hosts source code. Planning documents live in the local Cairn database.

Read the [tracker workflow in the integration guide](../integrations/matt-pocock.md#tracker-instructions-to-copy) before publishing a spec, converting a spec into tickets, reading a ticket's context, or updating progress. Resolve this repository with `cairn project resolve`. If the CLI is not installed yet, build it and invoke `node dist/cli.js` from this checkout.

For Matt Pocock's `/setup-matt-pocock-skills`, this is an **Other** issue tracker. `/to-spec` publishes a Cairn spec. `/to-tickets` publishes Cairn tickets with a spec parent and structured blocking edges. Retain those skills' document templates and review process.

Lifecycle states are `ready-for-agent` and `done`. Legacy labels remain stored as metadata; they do not control readiness. `cairn next` returns ready-for-agent tickets whose blockers are complete. See `triage-labels.md` for the legacy label vocabulary.
