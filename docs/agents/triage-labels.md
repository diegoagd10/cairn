# Triage labels

These legacy labels remain available as metadata:

| Role                 | Label             |
| -------------------- | ----------------- |
| Needs evaluation     | `needs-triage`    |
| Needs information    | `needs-info`      |
| Agent can proceed    | `ready-for-agent` |
| Human input required | `ready-for-human` |
| Will not implement   | `wontfix`         |

Use `--label` when creating or updating metadata. Labels do not control readiness. `cairn next` selects tickets with `ready-for-agent` status and completed blockers.
