#!/usr/bin/env node
// Claude Code PreToolUse hook (PAL-1543), after Möte's scripts/agent-guard.mjs and the factory's
// scripts/agent-guard.ts. It refuses a shell command that skips the git hooks, so lefthook.yml's
// fence runs on every agent commit and push. Every other command passes.
//
// Input: the hook's JSON on stdin. Output: a `deny` decision on stdout, or nothing.
import { readFileSync } from "node:fs";
import path from "node:path";

// It parses JSON by hand, not with Effect Schema: the hook runs before every agent Bash call, and
// loading `effect` costs about 0.3 s each time.
/** The Bash command in a PreToolUse input, or null for another tool or bad input. */
const bashCommand = (input) => {
  let hook;
  try {
    hook = JSON.parse(input);
  } catch {
    return null;
  }
  if (hook?.tool_name !== "Bash") {
    return null;
  }
  return String(hook.tool_input?.command ?? "");
};

// Heredoc bodies and quoted strings are data, such as a commit message that names a flag.
const stripData = (command) =>
  command
    .replaceAll(
      /<<-?\s*(?<quote>['"]?)(?<tag>\w+)\k<quote>[^\n]*\n[\s\S]*?\n\k<tag>(?=\n|$)/gu,
      "<<heredoc"
    )
    .replaceAll(/'[^']*'|"(?:[^"\\]|\\.)*"/gu, "''");

const gitCommand = /(?:^|[\s;&|()])(?:\S*\/)?git\s/u;

const rules = [
  [/(?:^|\s)--no-verify\b/u, "`--no-verify` skips the git hooks"],
  [
    /\bgit\s+(?:-\S+\s+(?:\S+\s+)?)*commit\b[^;&|]*\s-[a-zA-Z]*n[a-zA-Z]*(?=\s|$)/u,
    "`git commit -n` skips the git hooks",
  ],
  [
    /\bLEFTHOOK(?:_EXCLUDE)?=/u,
    "LEFTHOOK and LEFTHOOK_EXCLUDE turn the hooks off",
  ],
  [/\bHUSKY=0\b/u, "HUSKY=0 turns the hooks off"],
  [/\bcore\.hooksPath\b/u, "core.hooksPath moves the hooks away"],
];

/** Why the hook refuses `command`, or null when it passes. */
export const refusal = (command) => {
  const code = stripData(command);
  if (!gitCommand.test(code) && !/\bLEFTHOOK|\bHUSKY/u.test(code)) {
    return null;
  }
  const hit = rules.find(([pattern]) => pattern.test(code));
  return hit === undefined
    ? null
    : `agent-guard: ${hit[1]}. The hooks run \`bun run check\` on each commit, the fence every change passes (lefthook.yml). Drop the flag, read the hook's output and fix the failure; a hook that cannot pass goes to Parth.`;
};

/** The hook's stdout for one PreToolUse input. */
export const decide = (input) => {
  const command = bashCommand(input);
  if (command === null) {
    return "";
  }
  const reason = refusal(command);
  return reason === null
    ? ""
    : JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      });
};

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.stdout.write(decide(readFileSync(0, "utf-8")));
}
