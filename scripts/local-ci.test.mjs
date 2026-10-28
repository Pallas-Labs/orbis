import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(root, "scripts/local-ci.mjs");
const scratch = mkdtempSync(path.join(tmpdir(), "local-ci-"));

after(() => {
  rmSync(scratch, { force: true, recursive: true });
});

// Runs git in the scratch checkout and fails the test if it fails.
const git = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

// A checkout shaped like the repository: a package.json with a native format command and
// apps/apple, which the macOS lane copies with git archive.
const checkout = (name, { apple = true } = {}) => {
  const dir = path.join(scratch, name);
  mkdirSync(path.join(dir, "apps/apple"), { recursive: true });
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ scripts: { "native:format": "true" } })
  );
  if (apple) {
    writeFileSync(path.join(dir, "apps/apple/marker.txt"), "start\n");
  }
  git(dir, "init", "--quiet");
  git(dir, "add", "--all");
  git(
    dir,
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "--quiet",
    "-m",
    "start"
  );
  return dir;
};

// Every command the script runs comes from this directory. `bun run check` changes the
// checkout the way another process in the same worktree would; the rest succeed quietly and
// the gh stub records any call, so a test can tell that no status was posted.
const bin = (name) => {
  const dir = path.join(scratch, `bin-${name}`);
  mkdirSync(dir, { recursive: true });
  const write = (file, body) => {
    const target = path.join(dir, file);
    writeFileSync(target, `#!/bin/sh\n${body}`);
    chmodSync(target, 0o755);
  };
  write(
    "bun",
    `if [ "$1" = "run" ] && [ "$2" = "check" ]; then
  case "$LOCAL_CI_TEST_MUTATE" in
    dirty) echo changed >> apps/apple/marker.txt ;;
    commit)
      echo changed >> apps/apple/marker.txt
      git add --all
      git -c user.email=test@example.com -c user.name=Test commit --quiet -m mid-run
      ;;
  esac
fi
exit 0
`
  );
  write("bunx", "exit 0\n");
  write(
    "sh",
    'case "$*" in\n  *"command -v ffprobe"*) exit 0 ;;\nesac\ncat > /dev/null\nexit 0\n'
  );
  write("ssh", "cat > /dev/null\nexit 0\n");
  write("gh", 'echo "$@" >> "$LOCAL_CI_TEST_GH_LOG"\nexit 0\n');
  return dir;
};

const run = (dir, binDir, env) =>
  spawnSync(process.execPath, [script], {
    cwd: dir,
    encoding: "utf-8",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ...env },
  });

test("a tracked file that changes mid-run exits 1 and posts no status", () => {
  const dir = checkout("dirty");
  const ghLog = path.join(scratch, "gh-dirty.log");
  const result = run(dir, bin("dirty"), {
    LOCAL_CI_TEST_GH_LOG: ghLog,
    LOCAL_CI_TEST_MUTATE: "dirty",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /No status posted/u);
  assert.notEqual(git(dir, "status", "--porcelain"), "");
  assert.equal(existsSync(ghLog), false);
});

test("a HEAD that moves mid-run exits 1 and posts no status", () => {
  const dir = checkout("commit");
  const start = git(dir, "rev-parse", "HEAD");
  const ghLog = path.join(scratch, "gh-commit.log");
  const result = run(dir, bin("commit"), {
    LOCAL_CI_TEST_GH_LOG: ghLog,
    LOCAL_CI_TEST_MUTATE: "commit",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /No status posted/u);
  assert.notEqual(git(dir, "rev-parse", "HEAD"), start);
  assert.equal(existsSync(ghLog), false);
});

test("a git archive that fails exits 1 and posts no status", () => {
  const dir = checkout("no-apple", { apple: false });
  const ghLog = path.join(scratch, "gh-archive.log");
  const result = run(dir, bin("archive"), {
    LOCAL_CI_TEST_GH_LOG: ghLog,
    LOCAL_CI_TEST_MUTATE: "none",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /failed at macos on cortex: Copy apps\/apple/u);
  assert.match(result.stderr, /No status posted/u);
  assert.equal(existsSync(ghLog), false);
});
