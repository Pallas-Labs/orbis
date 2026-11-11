#!/usr/bin/env node
// Local CI. Runs what the Code quality workflow ran, then posts the `local-ci` and `verify`
// commit statuses on HEAD. Orbis runs no GitHub Actions (PAL-1048), so a green `local-ci` status
// means the checks passed. `verify` is the status the factory's merge rule reads on every product
// repo (factory v2, PAL-1852); for Orbis it is these same checks, so both post the same result.
//
// Usage:
//   bun run ci                    # Linux checks here, macOS checks on a leased Mac
//   bun run ci --mac-host mac     # pin the lease to a Mac host: cortex or mac
//   bun run ci --no-status        # run the checks, post no status
//
// On macOS, the macOS checks run in this checkout unless --mac-host is given. Elsewhere, they
// take the factory's Xcode slot on a Mac through `factory lease run --needs xcode` (PAL-1336),
// which copies this checkout to the Mac, runs them there and exits with their code. FACTORY_CLI
// names the factory command, `~/.local/share/factory/bin/factory` by default. React Doctor
// reports only issues that HEAD adds against --base (origin/main). Just before posting, it
// checks the checkout still is the starting commit and still clean; otherwise it posts nothing
// (PAL-1138).

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import os from "node:os";
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
const macHost = argument("mac-host");
const onThisMac = process.platform === "darwin" && macHost === undefined;
const factory = (
  process.env.FACTORY_CLI ??
  path.join(os.homedir(), ".local/share/factory/bin/factory")
).split(/\s+/u);
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
const exec = async (command, { log, env } = {}) => {
  const child = spawn(command[0], command.slice(1), {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", log ? "pipe" : "inherit", log ? "pipe" : "inherit"],
  });
  if (log) {
    child.stdout.on("data", (chunk) => {
      log.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      log.push(chunk);
    });
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
  const [step, command, options = {}] = first;
  const say = (line) => {
    if (log) {
      log.push(Buffer.from(`${line}\n`));
    } else {
      console.log(line);
    }
  };
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

// One lease for both remote steps. The checkout is clean at `sha`, so the copy is that commit. The
// design package's build folder stays in the issue's sat- folder on the Mac until the PR merges, so
// the next run builds warm.
const leasedMacStep = [
  "Check Swift style and test the design package",
  [
    ...factory,
    "lease",
    "run",
    "--needs",
    "xcode",
    ...(macHost === undefined ? [] : ["--host", macHost]),
    "--",
    "sh",
    "-c",
    `${scripts["native:format"]} && ${designTest("apps/apple/OrbisDesign/.build")}`,
  ],
];

const mac = async () => {
  const log = [];
  const failed = onThisMac
    ? await lane(
        "macos",
        [
          ["Check Swift style", ["sh", "-c", scripts["native:format"]]],
          [
            "Test the design package",
            ["sh", "-c", designTest("apps/apple/OrbisDesign/.build")],
          ],
        ],
        log
      )
    : await lane("macos on a leased Mac", [leasedMacStep], log);
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

// The status names the commit the checks started on, so that commit must still be HEAD and
// the tree still clean. Another process may edit or commit in this worktree during the run.
const head = git("rev-parse", "HEAD");
const changes = git("status", "--porcelain");
if (head !== sha || changes !== "") {
  const moved = head === sha ? "" : `, now ${head}`;
  const dirty = changes === "" ? "" : `, with changes:\n${changes}`;
  console.error(
    `\nlocal-ci: the checkout changed during the run. Started at ${sha}${moved}${dirty}. No status posted.`
  );
  process.exit(1);
}

const repo = spawnSync(
  "gh",
  ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
  { cwd: root, encoding: "utf-8" }
).stdout.trim();
const description = `bun run ci passed (macOS checks on ${onThisMac ? "this Mac" : (macHost ?? "a leased Mac")})`;
const contexts = ["local-ci", "verify"];
for (const context of contexts) {
  const posted = spawnSync(
    "gh",
    [
      "api",
      `repos/${repo}/statuses/${sha}`,
      "-f",
      "state=success",
      "-f",
      `context=${context}`,
      "-f",
      `description=${description}`,
      "--silent",
    ],
    { cwd: root, encoding: "utf-8" }
  );
  if (posted.status !== 0) {
    console.error(
      `\nlocal-ci: passed, but posting the ${context} status failed. Push ${sha} first.\n${posted.stderr}`
    );
    process.exit(1);
  }
}
console.log(
  `\nlocal-ci: passed. Posted ${contexts.map((context) => `${context}=success`).join(" and ")} on ${repo}@${sha}.`
);
