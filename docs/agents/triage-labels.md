# Triage labels

| Canonical role | Linear label | Meaning |
| --- | --- | --- |
| needs-triage | `needs-triage` | Maintainer evaluation needed. |
| needs-info | `needs-info` | Waiting for more information. |
| ready-for-agent | `ready-for-agent` | Fully specified for autonomous implementation. |
| ready-for-human | `ready-for-human` | Requires human implementation. |
| wontfix | `wontfix` | Will not be implemented. |

Canonical role names and Linear label names are identical.

## Linear mapping

The Linear team `Pallas` has labels with these exact names. Categories map to Linear's `Bug` (bug) and `Feature` or `Improvement` (enhancement).

Adding `ready-for-agent` to an existing Linear issue starts a T3 agent run for that issue (an Executor app relays the Linear webhook to T3). Apply it only when the agent brief is complete.
