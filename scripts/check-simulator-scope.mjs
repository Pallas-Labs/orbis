#!/usr/bin/env node
// Fails when simulator-scope.json leaves out a UI test that a change reaches (PAL-2063). `factory journeys`
// runs only the tests that the rules matching a changed path name, and a named rule hides the fallback. So when a type declared in one rule's files is used in a file that another rule matches, the
// first rule must also name the second rule's tests: a change to `AudioPlayer` must run the
// tests of every screen that plays through it.
//
//   node scripts/check-simulator-scope.mjs
//
// It reads type declarations (struct, class, enum, protocol, actor, typealias) that are not private. A file
// that no named rule matches, such as OrbisApp.swift, takes the fallback, which runs every test, so a use
// there asks for nothing. A file that `ignore` drops from the fallback runs no test of its own, so the
// tests its types reach must come from a named rule.
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
 * Each test that a change to an app file reaches but its named rules leave out: the file declares a type
 * that a file of another named rule uses. A changed path takes every rule that matches it, so the tests
 * of all the rules that match the file count. `files` maps each app Swift path to its source.
 */
export const scopeProblems = (scope, files) => {
  const named = scope.rules.filter(
    (rule) => rule.platform === "ios" && rule.fallback !== true
  );
  const problems = [];
  for (const [path, source] of files) {
    const own = named.filter((rule) => matches(rule, path));
    const ignored = (scope.ignore ?? []).some((glob) =>
      globPattern(glob).test(path)
    );
    // No named rule: the fallback runs every test, unless `ignore` drops the file from it.
    if (own.length === 0 && !ignored) {
      continue;
    }
    const tests = own.flatMap((rule) => rule.tests);
    const names = declaredTypes(source);
    const missing = new Map();
    for (const [other, otherSource] of files) {
      const consumers = named.filter(
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
  const paths = execFileSync("git", ["ls-files", "--", `${APP_DIR}*.swift`], {
    encoding: "utf-8",
  })
    .split("\n")
    .filter((path) => path !== "");
  const files = new Map(
    paths.map((path) => [path, fs.readFileSync(path, "utf-8")])
  );
  const problems = scopeProblems(scope, files);
  for (const problem of problems) {
    console.error(`simulator-scope.json: ${problem}`);
  }
  if (problems.length > 0) {
    process.exit(1);
  }
  console.log(
    `simulator-scope.json: every named rule names the tests its types reach (${files.size} files)`
  );
};

if (process.argv[1] === import.meta.filename) {
  main();
}
