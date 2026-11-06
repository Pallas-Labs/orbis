// The fence (PAL-1543) checks itself. Each part can fail in a way that lets bad code through
// silently, so each test below plants the bad code and expects a refusal:
//
// - A lint rule stops reporting its shape, or reports a shape it should allow: the fixture's
//   `expect:` lines no longer match what real Oxlint reports.
// - The bounded-read scanner misses a read, flags a bounded one, or the baseline stops
//   shrinking: planted sources and baselines give the wrong findings.
// - The agent guard lets `--no-verify` or another hook bypass through, or refuses quoted text.
// - A tsconfig keeps Effect warnings out of the tsc exit code: a planted warning passes tsc.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { decide, refusal } from "./agent-guard.mjs";
import { newFindings, scanSource, staleReads } from "./check-bounded-reads.mjs";

const root = path.resolve(import.meta.dirname, "..");
const bin = (name) => path.join(root, "node_modules/.bin", name);

const scan = (source) =>
  scanSource(source, "apps/server/src/x.ts").map(
    ({ line, rule }) => `${line} ${rule}`
  );

const rawRead = (text) => ({
  file: "apps/server/src/x.ts",
  read: text,
  rule: "raw-select",
});

const hookInput = (tool, command) =>
  JSON.stringify({ tool_input: { command }, tool_name: tool });

describe("orbis lint rules", () => {
  test("real Oxlint reports each fixture line marked `expect:` and nothing else", () => {
    const fixtures = path.join(root, "lint-plugins/orbis/fixtures");
    const file = path.join(fixtures, "fence.ts");
    const run = spawnSync(
      bin("oxlint"),
      ["-c", path.join(fixtures, "oxlintrc.json"), "-f", "json", file],
      { cwd: root, encoding: "utf-8" }
    );
    const reported = JSON.parse(run.stdout)
      .diagnostics.map(
        (diagnostic) =>
          `${diagnostic.labels[0].span.line} ${diagnostic.code.replace(/^(?<plugin>\w+)\((?<rule>.+)\)$/u, "$<plugin>/$<rule>")}`
      )
      .toSorted();
    const expected = readFileSync(file, "utf-8")
      .split("\n")
      .flatMap((line, index) => {
        const here = /\/\/ expect: (?<rule>orbis\/[\w-]+)$/u.exec(line);
        const next = /\/\/ expect-next: (?<rule>orbis\/[\w-]+)$/u.exec(line);
        if (here !== null) {
          return [`${index + 1} ${here.groups.rule}`];
        }
        return next === null ? [] : [`${index + 2} ${next.groups.rule}`];
      })
      .toSorted();
    assert.ok(expected.length >= 10);
    assert.deepEqual(reported, expected);
  });
});

describe("bounded reads", () => {
  test("finds a Drizzle select with no limit", () => {
    assert.deepEqual(
      scan(
        "const rows = yield* db\n  .select({ id: sets.id })\n  .from(sets)\n  .where(eq(sets.state, 'ready'));"
      ),
      ["1 drizzle-select"]
    );
  });

  test("allows a limit, one row, aggregates, a subquery and an annotation", () => {
    assert.deepEqual(
      scan(
        [
          "const a = yield* db.select().from(sets).limit(50);",
          "const b = yield* db.select().from(sets).where(eq(sets.id, id)).get();",
          "const c = yield* db.select({ n: count() }).from(sets);",
          "const d = yield* db.select({ n: sql<number>`COUNT(*)` }).from(sets);",
          "const e = yield* db.delete(sets).where(inArray(sets.id, db.select({ id: old.id }).from(old)));",
          "// bounded-read: one row per Person, and a Group holds a handful of People.",
          "const f = yield* db.select().from(people);",
        ].join("\n")
      ),
      []
    );
  });

  test("finds a read that a wrapper runs, but not one an operator composes", () => {
    assert.deepEqual(
      scan(
        [
          "const a = yield* execute(db.select().from(sets));",
          "const b = yield* Effect.tryPromise(() => db.select().from(sets).all());",
          "const c = yield* execute(db.select().from(sets).where(notInArray(sets.id, db.select({ id: old.id }).from(old))));",
          "const d = yield* execute(db.select().from(sets).where(exists(db.select().from(old).where(eq(old.id, sets.id)))).limit(5));",
        ].join("\n")
      ),
      ["1 drizzle-select", "2 drizzle-select", "3 drizzle-select"]
    );
  });

  test("finds grouped aggregates and raw SQL with no LIMIT", () => {
    assert.deepEqual(
      scan(
        [
          "const a = yield* db.select({ n: count() }).from(sets).groupBy(sets.state);",
          'const b = db.query("SELECT id FROM sets WHERE state = ?").all(state);',
          'const c = db.query("SELECT id FROM sets LIMIT 10").all();',
          'const d = db.query("SELECT count(*) AS n FROM sets").get();',
        ].join("\n")
      ),
      ["1 drizzle-select", "2 raw-select"]
    );
  });

  test("the baseline holds known reads, fails new ones, and only shrinks", () => {
    const baseline = {
      "apps/server/src/x.ts": {
        "raw-select": ["SELECT a FROM t", "SELECT b FROM t"],
      },
    };
    const findings = [rawRead("SELECT a FROM t"), rawRead("SELECT a FROM t")];
    assert.deepEqual(newFindings(findings, baseline), [
      rawRead("SELECT a FROM t"),
    ]);
    assert.deepEqual(staleReads(findings, baseline), [
      rawRead("SELECT b FROM t"),
    ]);
  });
});

describe("agent guard", () => {
  test("refuses each way to skip the hooks", () => {
    for (const command of [
      "git commit --no-verify -m wip",
      "git commit -nm wip",
      "git push --no-verify origin HEAD",
      "LEFTHOOK=0 git commit -m wip",
      "git -c core.hooksPath=/dev/null commit -m wip",
      'git commit "--no-verify" -m wip',
      "git push '--no-verify'",
      "git push --no-veri\\fy",
      "git push --no-'verify'",
      "git push $'--no-verify'",
      "git commit -m wip --no-verif",
      "git commit '-n' -m wip",
      'git commit -m "wip" -n',
      "git commit --message='a b' --no-verify",
      'bash -c "git commit --no-verify -m wip"',
    ]) {
      assert.notEqual(refusal(command), null, command);
    }
  });

  test("passes ordinary commands and quoted text that names a flag", () => {
    for (const command of [
      "git commit -m 'never use --no-verify'",
      'git commit -am "skip -n and --no-verify"',
      "git commit --message='never --no-verify'",
      "git commit -F msg.txt",
      "git commit -m \"$(cat <<'EOF'\nnever use --no-verify\nEOF\n)\"",
      'gh pr comment 1 --body "git push --no-verify passes"',
      "git push --force-with-lease origin HEAD:topic",
      "git --no-pager log -n 5",
      "ls -n",
      "bun run check",
    ]) {
      assert.equal(refusal(command), null, command);
    }
  });

  test("answers Claude Code with a deny decision for Bash only", () => {
    assert.equal(
      JSON.parse(decide(hookInput("Bash", "git commit --no-verify")))
        .hookSpecificOutput.permissionDecision,
      "deny"
    );
    assert.equal(decide(hookInput("Read", "git commit --no-verify")), "");
    assert.equal(decide("not json"), "");
  });
});

describe("Effect diagnostics", () => {
  test("no tsconfig keeps an Effect diagnostic out of the tsc exit code", () => {
    const tsconfigs = execFileSync(
      "git",
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        ":(glob)**/tsconfig*.json",
      ],
      { cwd: root, encoding: "utf-8" }
    )
      .split("\n")
      .filter((file) => file !== "");
    const loosened = tsconfigs.filter((file) =>
      /"ignoreEffect\w*InTscExitCode"\s*:\s*true/u.test(
        readFileSync(path.join(root, file), "utf-8")
      )
    );
    assert.ok(tsconfigs.length >= 6);
    assert.deepEqual(loosened, []);
  });

  test("an Effect warning fails tsc", () => {
    const run = spawnSync(
      bin("tsc"),
      ["-p", "scripts/fixtures/effect-diagnostics/tsconfig.json"],
      { cwd: root, encoding: "utf-8" }
    );
    assert.match(run.stdout, /warning TS377033/u);
    assert.notEqual(run.status, 0);
  });
});
