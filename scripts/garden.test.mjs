import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { measure as measureRoot } from "./garden.mjs";

const sensor = fileURLToPath(new URL("garden.mjs", import.meta.url));

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

const reader = [
  "export const read = (value: unknown) => value as string;",
  "// oxlint-disable-next-line no-console -- The fixture logs once.",
  'console.log("ready");',
  "// TODO: remove the old reader",
  "",
].join("\n");

// A repository with one finding of each scanned kind and no node_modules, so oxlint is missing.
const fixture = {
  "README.md":
    "Run `bun run check` or `bun run missing`. Read `src/lib.ts` and `src/gone.ts`.\n",
  "Sources/App.swift":
    'let url = URL(string: "https://example.com")!\nlet values = [a!, b!, c!, d!]\n',
  "package.json": `${JSON.stringify({ name: "garden-fixture", scripts: { check: "turbo run lint --continue" } })}\n`,
  "src/lib.test.ts": 'test.skip("waits for the service", () => {});\n',
  "src/lib.ts": reader,
  "src/pair.ts": "export const pair = (a?: string, b?: string) => [a!, b!];\n",
};

let root = "";
let scratch = "";
// The first run on the initial commit, shared by the tests that only read it.
let initial = null;

const gitIn = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf-8", env: gitEnv });

const git = (...args) => gitIn(root, ...args);

const write = (file, content) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), content);
};

const commit = (message) => {
  git("add", "--all");
  git("commit", "--quiet", "--message", message);
};

const runSensor = (...args) =>
  execFileSync(process.execPath, [sensor, ...args], {
    cwd: root,
    encoding: "utf-8",
  });

const measure = () => JSON.parse(runSensor());

const metricValue = (run, id) =>
  run.metrics.find((item) => item.id === id)?.value;

const withoutTimes = (run) => ({
  ...run,
  measuredAt: null,
  metrics: run.metrics.filter((item) => item.unit !== "seconds"),
});

const findingOf = (run, kind) =>
  run.findings.find((item) => item.kind === kind);

before(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "garden-"));
  root = path.join(scratch, "repo");
  mkdirSync(root);
  git("init", "--quiet", "--initial-branch=main");
  for (const [file, content] of Object.entries(fixture)) {
    write(file, content);
  }
  commit("Work around a flaky upload");
  initial = measure();
});

after(() => {
  rmSync(scratch, { force: true, recursive: true });
});

test("a run prints schema-1 JSON with a metric for each scanned kind", () => {
  const run = initial;
  assert.equal(run.schema, 1);
  assert.equal(run.repo, "garden-fixture");
  assert.equal(run.commit, git("rev-parse", "HEAD").trim());
  assert.ok(!Number.isNaN(Date.parse(run.measuredAt)));
  assert.deepEqual(
    {
      "docs.stale-refs": metricValue(run, "docs.stale-refs"),
      "history.workarounds": metricValue(run, "history.workarounds"),
      markers: metricValue(run, "markers"),
      suppressions: metricValue(run, "suppressions"),
      "swift.force-operations": metricValue(run, "swift.force-operations"),
      "tests.skipped": metricValue(run, "tests.skipped"),
      "typescript.assertions": metricValue(run, "typescript.assertions"),
    },
    {
      "docs.stale-refs": 2,
      "history.workarounds": 1,
      markers: 1,
      suppressions: 1,
      "swift.force-operations": 5,
      "tests.skipped": 1,
      "typescript.assertions": 3,
    }
  );
  const stale = run.findings.filter((item) => item.kind === "stale-doc-ref");
  assert.deepEqual(stale.map((item) => item.detail).toSorted(), [
    "`src/gone.ts` does not exist (src/gone.ts)",
    "no package.json defines the script `missing`",
  ]);
});

test("a metric whose tool is missing is skipped with a reason and does not fail the run", () => {
  const run = initial;
  const skipped = new Map(run.skipped.map((item) => [item.id, item.reason]));
  for (const id of ["lint.errors", "lint.warnings", "deadcode.unused"]) {
    assert.equal(skipped.get(id), "oxlint is not installed; run bun install");
    assert.equal(metricValue(run, id), undefined);
  }
  if (process.platform !== "darwin") {
    assert.equal(
      skipped.get("swift.format"),
      "needs macOS (xcrun swift-format)"
    );
  }
});

test("two runs on one commit report the same findings and counts", () => {
  assert.deepEqual(withoutTimes(measure()), withoutTimes(measure()));
});

test("a moved finding keeps its id, and --compare lists new, repeated, and resolved findings", () => {
  const previous = initial;
  const previousFile = path.join(scratch, "previous.json");
  const currentFile = path.join(scratch, "current.json");
  writeFileSync(previousFile, JSON.stringify(previous));

  write(
    "src/lib.ts",
    `// The reader module.\n\n${reader.replace(
      "// TODO: remove the old reader",
      "// FIXME: the reader drops empty values"
    )}`
  );
  commit("Move the reader");

  const summary = runSensor("--compare", previousFile, "--out", currentFile);
  const current = JSON.parse(readFileSync(currentFile, "utf-8"));

  const original = findingOf(previous, "suppression");
  const moved = findingOf(current, "suppression");
  assert.equal(moved.id, original.id);
  assert.equal(moved.line, original.line + 2);
  assert.equal(
    findingOf(current, "type-assertion").id,
    findingOf(previous, "type-assertion").id
  );

  const section = (title) => {
    const start = summary.indexOf(`#### ${title}`);
    const end = summary.indexOf("\n####", start + 1);
    return summary.slice(start, end === -1 ? undefined : end);
  };
  const resolved = findingOf(previous, "marker");
  const added = findingOf(current, "marker");
  assert.notEqual(added.id, resolved.id);
  assert.match(section("New findings"), /^#### New findings \(1\)\n/u);
  assert.ok(section("New findings").includes(added.id));
  assert.match(
    section("Resolved findings"),
    /^#### Resolved findings \(1\)\n/u
  );
  assert.ok(section("Resolved findings").includes(resolved.id));
  assert.ok(section("Repeated findings").includes(moved.id));
  assert.ok(!section("Repeated findings").includes(added.id));
  assert.match(summary, /\| markers \| 1 \| 1 \| 0 \|/u);
  assert.match(
    summary,
    /`lint\.errors` \(oxlint is not installed; run bun install\)/u
  );
});

test("each force operation and assertion on a line counts once", () => {
  const ids = (kind, file) =>
    initial.findings
      .filter((item) => item.kind === kind && item.location === file)
      .map((item) => item.id);
  const swift = ids("force-operation", "Sources/App.swift");
  const typescript = ids("type-assertion", "src/pair.ts");
  assert.equal(swift.length, 5);
  assert.equal(new Set(swift).size, 5);
  assert.equal(typescript.length, 2);
  assert.equal(new Set(typescript).size, 2);
});

// Measures a repository whose native:format script runs `wrapper`, as if on macOS.
const measureSwiftFormat = (name, wrapper) => {
  const repo = path.join(scratch, name);
  const xcrun = path.join(repo, "xcrun");
  mkdirSync(path.join(repo, "Sources"), { recursive: true });
  gitIn(repo, "init", "--quiet", "--initial-branch=main");
  writeFileSync(xcrun, `#!/bin/sh\n${wrapper}`, { mode: 0o755 });
  writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({
      name,
      scripts: { "native:format": `${xcrun} swift-format lint Sources` },
    })
  );
  writeFileSync(path.join(repo, "Sources/App.swift"), "let a = 1\n");
  gitIn(repo, "add", "--all");
  gitIn(repo, "commit", "--quiet", "--message", "Swift fixture");
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    return measureRoot(repo);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
};

test("swift.format is skipped when swift-format fails without diagnostics", () => {
  const run = measureSwiftFormat(
    "swift-missing",
    'echo "xcrun: error: unable to find utility swift-format" >&2\nexit 1\n'
  );
  assert.equal(metricValue(run, "swift.format"), undefined);
  assert.equal(
    run.skipped.find((item) => item.id === "swift.format")?.reason,
    "swift-format exited with status 1 and no diagnostics: xcrun: error: unable to find utility swift-format"
  );
});

test("swift.format counts real diagnostics when swift-format exits nonzero", () => {
  const run = measureSwiftFormat(
    "swift-drift",
    'echo "Sources/App.swift:1:5: warning: [Spacing] remove the space" >&2\nexit 1\n'
  );
  assert.equal(metricValue(run, "swift.format"), 1);
  assert.equal(
    run.skipped.find((item) => item.id === "swift.format"),
    undefined
  );
  assert.equal(
    findingOf(run, "lint")?.detail,
    "swift-format: [Spacing] remove the space"
  );
});
