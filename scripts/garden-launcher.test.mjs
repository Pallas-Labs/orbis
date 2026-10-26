import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const launcher = path.join(root, "scripts/garden");
const manifest = () =>
  JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8"));
const config = () =>
  JSON.parse(readFileSync(path.join(root, "garden.config.json"), "utf-8"));
const scratch = mkdtempSync(path.join(tmpdir(), "garden-launcher-"));

after(() => {
  rmSync(scratch, { force: true, recursive: true });
});

// A fake garden that prints its name and arguments, one per line, and exits 7.
const fakeGarden = (name) => {
  const dir = path.join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "garden");
  writeFileSync(
    file,
    `#!/bin/sh\necho ${name}\nfor a in "$@"; do echo "$a"; done\nexit 7\n`
  );
  chmodSync(file, 0o755);
  return { dir, file };
};

// Runs the launcher with only the system directories and `extraPath` on PATH.
const launch = (args, { extraPath = [], gardenBin } = {}) => {
  const env = { PATH: [...extraPath, "/usr/bin", "/bin"].join(":") };
  if (gardenBin !== undefined) {
    env.GARDEN_BIN = gardenBin;
  }
  return spawnSync(launcher, args, { encoding: "utf-8", env });
};

test("runs the garden on PATH with every argument unchanged", () => {
  const onPath = fakeGarden("path");
  const result = launch(["sense", "--out", "a b.json"], {
    extraPath: [onPath.dir],
  });
  assert.equal(result.status, 7);
  assert.equal(result.stdout, "path\nsense\n--out\na b.json\n");
});

test("GARDEN_BIN wins over the garden on PATH", () => {
  const onPath = fakeGarden("path");
  const pinned = fakeGarden("pinned");
  const result = launch(["sense"], {
    extraPath: [onPath.dir],
    gardenBin: pinned.file,
  });
  assert.equal(result.status, 7);
  assert.equal(result.stdout, "pinned\nsense\n");
});

test("a GARDEN_BIN that is not executable exits 2 and never falls back to PATH", () => {
  const onPath = fakeGarden("path");
  const result = launch(["sense"], {
    extraPath: [onPath.dir],
    gardenBin: path.join(scratch, "missing/garden"),
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /GARDEN_BIN is .*missing\/garden, which is not an executable file/u
  );
});

test("with no garden, it exits 2 and says how to get one", () => {
  const result = launch(["sense"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no garden CLI found/u);
  assert.match(result.stderr, /GARDEN_BIN/u);
  assert.match(result.stderr, /apps\/garden-cli/u);
});

test("bun run garden is garden sense", () => {
  assert.equal(manifest().scripts.garden, "scripts/garden sense");
});

// The v1 sensor read both commands from package.json; the config copies them, so these keep it current.
test("the swift-format probe runs the native:format command, on macOS only", () => {
  assert.deepEqual(config().tools["format.swift-format"], {
    argv: manifest().scripts["native:format"].split(" "),
    platforms: ["darwin"],
  });
});

test("the gate steps are the turbo tasks of bun run check, each forced", () => {
  const words = manifest().scripts.check.split(/\s+/u);
  assert.deepEqual(words.slice(0, 2), ["turbo", "run"]);
  const tasks = words.slice(
    2,
    words.findIndex((word) => word.startsWith("-"))
  );
  assert.deepEqual(
    config().gate.steps,
    tasks.map((task) => ({
      argv: [
        "node_modules/.bin/turbo",
        "run",
        task,
        "--force",
        "--output-logs=errors-only",
      ],
      id: task,
    }))
  );
});
