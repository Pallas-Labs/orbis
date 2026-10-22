# Issue tracker: Linear

Specs and tickets live in Linear, team `Pallas`, project `Orbis`.

## Access through Executor

Agents reach Linear through the Executor MCP.

1. Find a tool with `search`, for example `linear save_issue`. Take the exact path and input type from the result, and never guess argument names.
2. Run it with `call`, or with `execute` when one result feeds the next call.
3. If Executor tools are absent from the session, say so and ask for access. Do not write local `.scratch/` issue files.

A missing standalone Linear connector does not mean Linear is unreachable. Credentials stay out of chat and repository files.

## Operations

All operations use team `Pallas` (key `PAL`) and project `Orbis`. Pass `team: "Pallas"` and `project: "Orbis"` when you create an issue.

- Create: `tools.linear.mutations.save_issue` with `team`, `project`, `title`, `description`, and `labels`.
- Read: `tools.linear.queries.get_issue` with the issue key (`PAL-123`). Request `includeRelations` for blockers. Comments are not in the issue; request them separately when you need the discussion.
- List: `tools.linear.queries.list_issues` with `project: "Orbis"`. Filter by `state`, `label`, `assignee`, or `parentId`.
- Comment: `tools.linear.mutations.save_comment` with `issueId` and `body`.
- Label: `save_issue` with `id`, `addLabels`, and `removeLabels`.
- Close: `save_issue` with `id` and a closing `state` (`Done` or `Canceled`), then a comment with the resolution.

"Publish to the issue tracker" means create a Linear issue in this project. "Fetch the relevant ticket" means read the issue and its comments.

The project is at https://linear.app/parthm/project/orbis-4cbc2f5c043a.

## Moved GitHub issues

This repo used GitHub Issues until 2026-10-22. Every open GitHub issue was copied to Linear and closed on GitHub with a link. Each moved Linear issue links its GitHub original. A `#N` in Linear issue text, ADRs, or older docs refers to a closed GitHub issue, not a Linear issue. Use the Linear issue for current scope and status.

Publish specs as Linear issues. Refer to issues by linked title.

**PRs as a request surface: no.**

## Readiness and completion

Before marking a ticket ready, resolve every required repository path and ADR link on its target branch. If a required decision is still in a PR, record that PR as a blocker. ADRs state the intended design; issue acceptance checks record what is implemented and verified.

Keep implementation and live acceptance as separate checks on parent issues. Record each remaining external blocker and link the latest evidence. Close a parent only when all its acceptance checks pass, including live checks.

Link the [verification record](../development.md#retain-verification-evidence) from the resolution comment. Retain failed-run artifacts before retrying.

Apply `ready-for-agent` only after these checks pass, because it starts an agent run (see `triage-labels.md`).

## Wayfinding operations

- Map: one Linear issue labelled `wayfinder:map`, with Notes, Decisions-so-far, and Fog sections.
- Child: one Linear sub-issue per ticket (`parentId` is the map's key), labelled `wayfinder:<type>` with type research, prototype, grilling, or task.
- Blocking: Linear `blockedBy` relations. Set them with `save_issue` and `blockedBy: ["PAL-n"]`, and read them with `get_issue` and `includeRelations`.
- Frontier: list the map's children with `list_issues` and `parentId`. Choose the first open child in map order with no assignee and no open blocker.
- Claim: `save_issue` with `assignee: "me"` before work.
- Resolve: comment with the answer, close the child, and append a summary and link to the map's Decisions-so-far.
