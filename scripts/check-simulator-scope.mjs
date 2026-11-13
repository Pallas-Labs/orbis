#!/usr/bin/env node
// Fails when simulator-scope.json leaves out a simulator test that a change reaches (PAL-2063, PAL-2267).
// `factory journeys` runs only the tests that the rules matching a changed path name, and a named rule
// hides the fallback. So when a type declared in one file is used in a file that a named rule matches,
// the declaring file's rules must also name that rule's tests: a change to `AudioPlayer` must run the
// tests of every screen that plays through it, on iOS and on tvOS.
//
//   node scripts/check-simulator-scope.mjs
//
// It reads type declarations (struct, class, enum, protocol, actor, typealias) that are not private. A file
// that no named rule matches takes its first fallback, so the fallback's tests are its own: the iOS
// fallback runs every iOS test, but no tvOS test. A use in a file that only the fallback, or a named rule
// with the fallback's tests, matches asks for nothing on that platform: that file already runs them all,
// and asking every type it uses for every test would undo the map. A file that `ignore` drops from the
// fallback runs no test of its own, so the tests its types reach must come from a named rule. It also
// fails on a glob that matches no tracked file, such as one a rename left behind.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

export const APP_DIR = "apps/apple/Orbis/";

/** A glob as an anchored regular expression, the way `factory journeys` reads it. */
export const globPattern = (glob) => {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += "\\^$.+(){}[]|".includes(char) ? `\\${char}` : char;
    }
  }
  return new RegExp(`^${source}$`, "u");
};

const matches = (rule, path) =>
  rule.paths.some((glob) => globPattern(glob).test(path));

/**
 * The rules a changed path takes, the way `factory journeys` picks them: every named rule that matches
 * it, or else its first matching fallback, unless `ignore` drops it from the fallback.
 */
export const rulesOf = (scope, path) => {
  const named = scope.rules.filter(
    (rule) => rule.fallback !== true && matches(rule, path)
  );
  const fallback = scope.rules.find(
    (rule) => rule.fallback === true && matches(rule, path)
  );
  const ignored = (scope.ignore ?? []).some((glob) =>
    globPattern(glob).test(path)
  );
  return named.length > 0 || ignored || fallback === undefined
    ? named
    : [fallback];
};

/** The tests a change to `path` runs, by platform: `factory journeys`'s `scopeOf` for one path. */
export const testsOf = (scope, path) => {
  const stem = (path.split("/").pop() ?? path).replace(/\.[^.]*$/u, "");
  const byPlatform = {};
  for (const rule of rulesOf(scope, path)) {
    const tests = rule.tests.map((test) => test.replaceAll("{stem}", stem));
    byPlatform[rule.platform] = [
      ...new Set([...(byPlatform[rule.platform] ?? []), ...tests]),
    ].toSorted((a, b) => a.localeCompare(b));
  }
  return byPlatform;
};

/** Each glob in `scope` that matches none of `paths`, such as one left behind by a rename. */
export const deadGlobs = (scope, paths) =>
  [
    ...new Set([
      ...(scope.ignore ?? []),
      ...scope.rules.flatMap((rule) => rule.paths),
    ]),
  ].filter((glob) => !paths.some((path) => globPattern(glob).test(path)));

// Top-level only: a nested type is named through its outer type, which this finds.
const declaration =
  /^(?:@\w+(?:\([^)\n]*\))?\s+)*(?<modifiers>(?:(?:public|private|fileprivate|internal|final|open|nonisolated|indirect)\s+)*)(?:struct|class|enum|protocol|actor|typealias)\s+(?<name>[A-Z]\w*)/gmu;

/** The top-level type names a Swift file declares that other files can use. */
export const declaredTypes = (source) =>
  [...source.matchAll(declaration)]
    .filter(
      ({ groups }) => !/\b(?:private|fileprivate)\b/u.test(groups.modifiers)
    )
    .map(({ groups }) => groups.name);

const withoutComments = (source) => source.replaceAll(/\/\/[^\n]*/gu, "");

/** True when `test` runs as part of `tests`: listed itself, or its whole target is. */
const covers = (tests, test) =>
  tests.includes(test) || tests.includes(test.split("/")[0]);

/**
 * Each test that a change to an app file reaches but its rules leave out: the file declares a type that a
 * file of another named rule uses, on any platform. The tests of every rule that matches the file count,
 * or of its first fallback when no named rule matches it. `files` maps each app Swift path to its source.
 */
export const scopeProblems = (scope, files) => {
  // A named rule that names a fallback's tests is a catch-all too, so a use in its files asks for nothing.
  const consumerRules = scope.rules.filter(
    (rule) =>
      rule.fallback !== true &&
      !scope.rules.some(
        (other) =>
          other.fallback === true &&
          other.platform === rule.platform &&
          other.tests.length === rule.tests.length &&
          other.tests.every((test) => rule.tests.includes(test))
      )
  );
  const problems = [];
  for (const [path, source] of files) {
    const own = rulesOf(scope, path);
    const tests = own.flatMap((rule) => rule.tests);
    const names = declaredTypes(source);
    const missing = new Map();
    for (const [other, otherSource] of files) {
      const consumers = consumerRules.filter(
        (rule) => !own.includes(rule) && matches(rule, other)
      );
      if (other === path || consumers.length === 0) {
        continue;
      }
      const declaredThere = new Set(declaredTypes(otherSource));
      const text = withoutComments(otherSource);
      for (const name of names) {
        if (
          declaredThere.has(name) ||
          !new RegExp(`\\b${name}\\b`, "u").test(text)
        ) {
          continue;
        }
        for (const test of consumers.flatMap((rule) => rule.tests)) {
          if (!(covers(tests, test) || missing.has(test))) {
            missing.set(test, `${name} in ${other}`);
          }
        }
      }
    }
    for (const [test, use] of missing) {
      problems.push(`${path} needs ${test}: ${use} uses a type it declares`);
    }
  }
  return problems;
};

const main = () => {
  const scope = JSON.parse(fs.readFileSync("simulator-scope.json", "utf-8"));
  const tracked = execFileSync("git", ["ls-files"], { encoding: "utf-8" })
    .split("\n")
    .filter((path) => path !== "");
  const files = new Map(
    tracked
      .filter((path) => path.startsWith(APP_DIR) && path.endsWith(".swift"))
      .map((path) => [path, fs.readFileSync(path, "utf-8")])
  );
  const problems = [
    ...deadGlobs(scope, tracked).map(
      (glob) => `${glob} matches no tracked file`
    ),
    ...scopeProblems(scope, files),
  ];
  for (const problem of problems) {
    console.error(`simulator-scope.json: ${problem}`);
  }
  if (problems.length > 0) {
    process.exit(1);
  }
  console.log(
    `simulator-scope.json: every glob matches a file and every rule names the tests its types reach (${files.size} files)`
  );
};

if (process.argv[1] === import.meta.filename) {
  main();
}
