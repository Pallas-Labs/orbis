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
  "Sources/App.swift": 'let url = URL(string: "https://example.com")!\n',
  "package.json": `${JSON.stringify({ name: "garden-fixture", scripts: { check: "turbo run lint --continue" } })}\n`,
  "src/lib.test.ts": 'test.skip("waits for the service", () => {});\n',
  "src/lib.ts": reader,
};

let root = "";
let scratch = "";
// The first run on the initial commit, shared by the tests that only read it.
let initial = null;

const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf-8", env: gitEnv });

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
      "swift.force-operations": 1,
      "tests.skipped": 1,
      "typescript.assertions": 1,
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
