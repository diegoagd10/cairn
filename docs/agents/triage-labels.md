# Triage labels

Use these strings for the canonical triage roles:

| Role                 | Label             |
| -------------------- | ----------------- |
| Needs evaluation     | `needs-triage`    |
| Needs information    | `needs-info`      |
| Agent can proceed    | `ready-for-agent` |
| Human input required | `ready-for-human` |
| Will not implement   | `wontfix`         |

Use `--label` when creating or updating a document. `cairn next` selects only `ready-for-agent` tickets; it also requires todo status and completed blockers.
