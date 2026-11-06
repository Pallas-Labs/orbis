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

// Shell characters that end a word and stand as a word of their own.
const operators = new Set([";", "&", "|", "(", ")", "<", ">"]);
// In double quotes, a backslash escapes only these.
const escapedInDoubleQuotes = new Set(["$", "`", '"', "\\", "\n"]);

/** The text of the quoted string that opens at `i` and the offset after it. */
const readQuoted = (command, i) => {
  // '...' keeps every character; $'...' also reads backslash escapes; "..." reads a few.
  const double = command[i] === '"';
  const ansi = command[i] === "$";
  const close = double ? '"' : "'";
  let j = i + (ansi ? 2 : 1);
  let text = "";
  while (j < command.length && command[j] !== close) {
    if (
      command[j] === "\\" &&
      (ansi || (double && escapedInDoubleQuotes.has(command[j + 1])))
    ) {
      j += 1;
    }
    text += command[j] ?? "";
    j += 1;
  }
  return { next: j + 1, text };
};

/**
 * The shell words of `command` after quote removal, as the shell hands them to git: `"--no-verify"`,
 * `--no-'verify'` and `--no-veri\fy` are all `--no-verify`. Operators are words of their own.
 */
const shellWords = (command) => {
  const words = [];
  let word = null;
  const add = (text) => {
    word = (word ?? "") + text;
  };
  const end = () => {
    if (word !== null) {
      words.push(word);
      word = null;
    }
  };
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (c === "\\") {
      add(command[i + 1] === "\n" ? "" : (command[i + 1] ?? ""));
      i += 2;
    } else if (
      c === "'" ||
      c === '"' ||
      (c === "$" && command[i + 1] === "'")
    ) {
      const { next, text } = readQuoted(command, i);
      add(text);
      i = next;
    } else if (/\s/u.test(c) || operators.has(c)) {
      end();
      if (operators.has(c)) {
        words.push(c);
      }
      i += 1;
    } else {
      add(c);
      i += 1;
    }
  }
  end();
  return words;
};

// Options whose value is text, such as a commit message that names a flag.
const messageOptions = new Set(["--body", "--file", "--message", "--title"]);

/** The words with each message value blanked, so only options and commands remain. */
const withoutData = (words) => {
  const out = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const long = /^(?<name>--[\w-]+)=/u.exec(word)?.groups?.name;
    // A short-option cluster: the first m or F takes the rest of the word, or the next word.
    const short = /^-(?<flags>[a-zA-Z]*?)(?<option>[mF])(?<value>.*)$/u.exec(
      word
    )?.groups;
    if (long !== undefined && messageOptions.has(long)) {
      out.push(`${long}=''`);
    } else if (messageOptions.has(word)) {
      out.push(word, "''");
      i += 1;
    } else if (short !== undefined && !word.startsWith("--")) {
      out.push(`-${short.flags}${short.option}`);
      if (short.value === "") {
        out.push("''");
        i += 1;
      }
    } else {
      out.push(word);
    }
  }
  return out.join(" ");
};

// Heredoc bodies are data too.
const stripData = (command) =>
  withoutData(
    shellWords(
      command.replaceAll(
        /<<-?\s*(?<quote>['"]?)(?<tag>\w+)\k<quote>[^\n]*\n[\s\S]*?\n\k<tag>(?=\n|$)/gu,
        "<<heredoc"
      )
    )
  );

const gitCommand = /(?:^|[\s;&|()])(?:\S*\/)?git\s/u;

// `git`, its global options, then `commit`.
const gitCommit = String.raw`\bgit\s+(?:-\S+\s+(?:\S+\s+)?)*commit\b`;

const rules = [
  // git reads a unique prefix of a long option as the option (gitcli(7)); `--no-ver` is ambiguous.
  [/(?:^|\s)--no-veri(?:fy?)?(?![\w-])/u, "`--no-verify` skips the git hooks"],
  [
    new RegExp(
      String.raw`${gitCommit}[^;&|]*\s-[a-zA-Z]*n[a-zA-Z]*(?=\s|$)`,
      "u"
    ),
    "`git commit -n` skips the git hooks",
  ],
  // A variable that holds a skip flag, as in `X=--no-verify; git push $X`. The guard does not
  // expand variables, so it refuses the assignment; a flag built in `$(...)` stays out of reach.
  [
    /(?:^|\s)[A-Za-z_]\w*=--no-veri(?:fy?)?(?![\w-])/u,
    "a variable set to `--no-verify` skips the git hooks",
  ],
  [
    new RegExp(
      String.raw`^(?=.*${gitCommit})(?:.*\s)?[A-Za-z_]\w*=-[a-zA-Z]*n[a-zA-Z]*(?=\s|$)`,
      "su"
    ),
    "a variable set to `-n` skips the git hooks of `git commit`",
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
