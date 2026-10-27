#!/usr/bin/env node
// Local CI. Runs what the Code quality workflow ran, then posts the `local-ci` commit status
// on HEAD. Orbis runs no GitHub Actions (PAL-1048), so a green `local-ci` status means the
// checks passed.
//
// Usage:
//   bun run ci                    # Linux checks here, macOS checks on cortex over ssh
//   bun run ci --mac-host mac     # macOS checks on another ssh host
//   bun run ci --no-status        # run the checks, post no status
//
// On macOS, the macOS checks run in this checkout unless --mac-host is given. Elsewhere,
// apps/apple at HEAD is copied to ~/.cache/orbis-local-ci/<sha> on the host, checked there
// and removed. React Doctor reports only issues that HEAD adds against --base (origin/main).

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";

// The checkout to check is the one this runs in, so a branch without this script can be checked
// with `node <path to>/local-ci.mjs`.
const root = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf-8",
}).stdout.trim();
const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const postStatus = !process.argv.includes("--no-status");
const macHost = argument(
  "mac-host",
  process.platform === "darwin" ? undefined : "cortex"
);
const base = argument("base", "origin/main");
const reactDoctor = "react-doctor@0.9.18";

const git = (...args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
};

// The status names a commit, so the checks must run on exactly that commit.
if (git("status", "--porcelain") !== "") {
  console.error(
    "local-ci: the working tree has changes. Commit or remove them first."
  );
  process.exit(1);
}
const sha = git("rev-parse", "HEAD");
const { scripts } = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf-8")
);

/// Runs one command and returns its exit code. With `log`, output is collected there
/// instead of streamed, so a parallel lane does not interleave with this one.
const exec = async (command, { input, log, env } = {}) => {
  const child = spawn(command[0], command.slice(1), {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: [
      input ? "pipe" : "ignore",
      log ? "pipe" : "inherit",
      log ? "pipe" : "inherit",
    ],
  });
  if (log) {
    child.stdout.on("data", (chunk) => log.push(chunk));
    child.stderr.on("data", (chunk) => log.push(chunk));
  }
  if (input) {
    input.pipe(child.stdin);
  }
  try {
    const [code] = await once(child, "close");
    return code ?? 1;
  } catch (error) {
    log?.push(Buffer.from(`${error.message}\n`));
    return 1;
  }
};

/// Runs steps in order and stops at the first failure. Returns the failed step's name.
/// Recursive rather than a loop, so each step is a separate await.
const lane = async (name, [first, ...rest], log) => {
  if (!first) {
    return;
  }
  const [step, command, options] = first;
  const say = (line) =>
    log ? log.push(Buffer.from(`${line}\n`)) : console.log(line);
  const started = performance.now();
  say(`\n[${name}] ${step}`);
  const code = await exec(command, { ...options, log });
  const seconds = ((performance.now() - started) / 1000).toFixed(0);
  say(
    `[${name}] ${step}: ${code === 0 ? "passed" : `exited ${code}`} in ${seconds} s`
  );
  return code === 0 ? lane(name, rest, log) : `${name}: ${step}`;
};

const linux = () =>
  lane("checks", [
    ["Install dependencies", ["bun", "install", "--frozen-lockfile"]],
    // The HTTP download tests probe audio with ffprobe.
    ["Find ffprobe", ["sh", "-c", "command -v ffprobe"]],
    [
      "Install browser for web journey",
      ["bunx", "playwright", "install", "chromium"],
    ],
    [
      "bun run check (oxlint, oxfmt, Ultracite, tsgo, tests, diagnostics)",
      ["bun", "run", "check"],
      { env: { TURBO_TELEMETRY_DISABLED: "1" } },
    ],
    [
      `React Doctor (apps/web, changed against ${base})`,
      [
        "bunx",
        reactDoctor,
        "apps/web",
        "--scope",
        "changed",
        "--base",
        base,
        "--blocking",
        "error",
        "--no-telemetry",
        "--yes",
      ],
    ],
  ]);

const designTest = (scratch) =>
  `swift test --package-path apps/apple/OrbisDesign --scratch-path ${scratch}`;

const mac = async () => {
  const log = [];
  let failed;
  if (macHost === undefined) {
    failed = await lane(
      "macos",
      [
        ["Check Swift style", ["sh", "-c", scripts["native:format"]]],
        [
          "Test the design package",
          ["sh", "-c", designTest("apps/apple/OrbisDesign/.build")],
        ],
      ],
      log
    );
  } else {
    // Each argument reaches the host's login shell (fish on the Macs), so the commands go
    // through `bash -c` in single quotes, and bash expands $HOME there.
    const dir = `$HOME/.cache/orbis-local-ci/${sha}`;
    const remote = (script) => ["ssh", macHost, "bash", "-c", `'${script}'`];
    const archive = spawn(
      "git",
      ["archive", "--format=tar", "HEAD", "apps/apple", "package.json"],
      { cwd: root, stdio: ["ignore", "pipe", "inherit"] }
    );
    failed = await lane(
      `macos on ${macHost}`,
      [
        [
          "Copy apps/apple at HEAD",
          remote(`rm -rf ${dir} && mkdir -p ${dir} && tar -x -C ${dir}`),
          { input: archive.stdout },
        ],
        [
          "Check Swift style",
          remote(`cd ${dir} && ${scripts["native:format"]}`),
        ],
        [
          "Test the design package",
          remote(
            `cd ${dir} && ${designTest("$HOME/.cache/orbis-local-ci/OrbisDesign-build")}`
          ),
        ],
      ],
      log
    );
    await exec(remote(`rm -rf ${dir}`), { log });
  }
  return { failed, log };
};

console.log(`local-ci: ${sha}`);
const macRun = mac();
const linuxFailed = await linux();
const { failed: macFailed, log } = await macRun;
process.stdout.write(Buffer.concat(log));

const failures = [linuxFailed, macFailed].filter(Boolean);
if (failures.length > 0) {
  console.error(
    `\nlocal-ci: failed at ${failures.join("; ")}. No status posted.`
  );
  process.exit(1);
}
if (!postStatus) {
  console.log("\nlocal-ci: passed. --no-status: no status posted.");
  process.exit(0);
}

const repo = spawnSync(
  "gh",
  ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
  { cwd: root, encoding: "utf-8" }
).stdout.trim();
const posted = spawnSync(
  "gh",
  [
    "api",
    `repos/${repo}/statuses/${sha}`,
    "-f",
    "state=success",
    "-f",
    "context=local-ci",
    "-f",
    `description=bun run ci passed (macOS checks on ${macHost ?? "this Mac"})`,
    "--silent",
  ],
  { cwd: root, encoding: "utf-8" }
);
if (posted.status !== 0) {
  console.error(
    `\nlocal-ci: passed, but posting the status failed. Push ${sha} first.\n${posted.stderr}`
  );
  process.exit(1);
}
console.log(`\nlocal-ci: passed. Posted local-ci=success on ${repo}@${sha}.`);
