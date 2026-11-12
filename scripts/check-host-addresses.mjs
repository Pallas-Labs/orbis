#!/usr/bin/env node
// Keeps machine details out of tracked files (PAL-2046). Orbis is public, so a tracked file may not
// name one of these:
//
// - tailnet-ip: an IPv4 address in 100.64/10, the range Tailscale gives its devices.
// - tailnet-host: a `*.ts.net` name, such as a Funnel or MagicDNS host.
// - home-path: a home folder, `/home/<name>` or `/Users/<name>`, a CI runner's home included. Write `~`.
//
// Tailscale's own resolver address, inside that range, counts too: name it with an allow entry.
//
// Code and tests use `example.test` names and documentation addresses (RFC 5737); docs use
// placeholders such as `<vanta-tailnet-ip>` and `<funnel-host>`. Real values come from the
// environment or an untracked file. scripts/host-addresses.allow.json lists each exception as
// `{ path, match, reason }`. An entry that allows nothing also fails, so the list only holds live
// exceptions.
//
//   node scripts/check-host-addresses.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const allowPath = "scripts/host-addresses.allow.json";

export const RULES = {
  "home-path": /(?<![\w.-])\/(?:home|Users)\/[\w.-]+/gu,
  "tailnet-host": /(?<![\w.-])(?:[a-z\d-]+\.)+ts\.net\b/giu,
  "tailnet-ip":
    /(?<![\d.])100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(?!\.?\d)/gu,
};

/// Each rule's matches in one file's text, with 1-based line numbers.
export const scanText = (text) =>
  text.split("\n").flatMap((line, index) =>
    Object.entries(RULES).flatMap(([rule, pattern]) =>
      [...line.matchAll(pattern)].map(([match]) => ({
        line: index + 1,
        match,
        rule,
      }))
    )
  );

const isAllowed = (finding, entry) =>
  entry.path === finding.file && entry.match === finding.match;

/// Findings in `files` (`{ file, text }`) that no allow entry covers, and allow entries that cover
/// no finding.
export const check = (files, allow) => {
  const findings = files.flatMap(({ file, text }) =>
    scanText(text).map((finding) => ({ file, ...finding }))
  );
  return {
    findings: findings.filter(
      (finding) => !allow.some((entry) => isAllowed(finding, entry))
    ),
    stale: allow.filter(
      (entry) => !findings.some((finding) => isAllowed(finding, entry))
    ),
  };
};

/// The text of one tracked file, or nothing when the file is gone from the working tree or binary
/// (a NUL byte in its first 8 KB).
const readText = (file) => {
  try {
    const bytes = readFileSync(file);
    return bytes.subarray(0, 8192).includes(0) ? null : bytes.toString("utf-8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

/// Tracked text files in the git checkout at `root`. Symlinks, which repeat their target's text,
/// binary files, files deleted from the working tree, and the allow list, which names each
/// exception, are skipped.
export const trackedFiles = (root) =>
  execFileSync("git", ["ls-files", "-s", "-z"], {
    cwd: root,
    encoding: "utf-8",
  })
    .split("\0")
    .flatMap((entry) => {
      const [stage, file] = entry.split("\t");
      if (
        file === undefined ||
        file === allowPath ||
        stage.startsWith("120000 ")
      ) {
        return [];
      }
      const text = readText(path.join(root, file));
      return text === null ? [] : [{ file, text }];
    });

export const readAllow = (root) => {
  const file = path.join(root, allowPath);
  const allow = existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) : [];
  if (!Array.isArray(allow)) {
    throw new TypeError(
      `${allowPath}: must hold a list of { path, match, reason } entries.`
    );
  }
  const missing = allow.filter(
    (entry) => !(entry.path && entry.match && entry.reason?.trim())
  );
  if (missing.length > 0) {
    throw new Error(
      `${allowPath}: each entry needs path, match and reason: ${JSON.stringify(missing)}`
    );
  }
  return allow;
};

/// Prints what fails and returns the exit code.
export const run = (root = repoRoot, say = console.error) => {
  const { findings, stale } = check(trackedFiles(root), readAllow(root));
  for (const { file, line, rule, match } of findings) {
    say(`${file}:${line} ${rule}: ${match}`);
  }
  for (const entry of stale) {
    say(
      `${allowPath}: ${entry.path} allows ${entry.match}, which is gone; remove the entry.`
    );
  }
  if (findings.length > 0) {
    say(
      `${findings.length} host detail(s) in tracked files. Use example.test, a documentation address, a placeholder such as <funnel-host>, or ~; or add an entry with its reason to ${allowPath}.`
    );
  }
  return findings.length > 0 || stale.length > 0 ? 1 : 0;
};

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = run();
}
