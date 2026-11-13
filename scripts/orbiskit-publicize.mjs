/* oxlint-disable require-unicode-regexp, prefer-named-capture-group, complexity, no-use-before-define, curly, unicorn/prefer-string-replace-all, unicorn/text-encoding-identifier-case, unicorn/import-style, unicorn/no-array-sort, typescript/require-array-sort-compare -- a one-off line-based Swift codemod: its regexes are ASCII patterns and it is kept as the record of the PAL-2196 move, not as a maintained tool */
// The codemod behind PAL-2196. It makes the files moved into OrbisKit usable from the app:
//
//   1. `public` on each top-level declaration and each member the app can reach,
//   2. `Sendable` on each public struct and enum, which a public type no longer infers,
//   3. `import OrbisKit` in each app file that names a type OrbisKit now owns
//      (`@testable import OrbisKit` in test files).
//
// Run it from the repository root. A second run changes nothing, which `--check` proves by
// exiting 1 when a run would write. It is kept in the repo as the record of the move; it is not a
// check that runs in `bun run check`.
//
//   node scripts/orbiskit-publicize.mjs           # edit the files
//   node scripts/orbiskit-publicize.mjs --check   # exit 1 when an edit is still pending
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const apple = "apps/apple";
const kitSources = join(apple, "OrbisKit/Sources/OrbisKit");
const kitFiles = [
  "Models.swift",
  "OrbisClient.swift",
  "OrbisClient+PlaybackDiagnostics.swift",
];
// The UI test bundles drive the app from outside and link no package: LaneService has its own types.
const appDirectories = ["Orbis", "OrbisShare", "OrbisTests"];
const check = process.argv.includes("--check");

let pending = 0;
const write = (path, before, after) => {
  if (before === after) return;
  pending += 1;
  console.log(`${check ? "would change" : "changed"} ${path}`);
  if (!check) writeFileSync(path, after);
};

/** The text of a line with strings and a trailing comment blanked, so braces in them do not count. */
const code = (line) =>
  line.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\/.*$/, "");

const typeKeyword = /^(?:final\s+)?(struct|enum|class|actor|protocol)\s+(\w+)/;
const memberKeyword =
  /^(?:(?:@\w+(?:\([^)]*\))?|static|class|final|nonisolated|mutating|override|lazy|indirect)\s+)*(let|var|func|init|struct|enum|class|typealias|subscript)\b/;

/** Adds `public` to what the app reaches in one Swift file of the package. */
const publicize = (source) => {
  const lines = source.split("\n");
  const exported = [];
  let depth = 0;
  let inBlockString = false;
  /** What the innermost top-level declaration allows its members to be. */
  let topLevel = { extensionOnly: false, kind: "", reachable: false };
  const out = lines.map((line) => {
    if ((line.match(/"""/g) ?? []).length % 2 === 1) {
      inBlockString = !inBlockString;
      return line;
    }
    if (inBlockString) return line;
    const plain = code(line);
    const trimmed = plain.trim();
    const indent = line.length - line.trimStart().length;
    let result = line;
    if (depth === 0 && indent === 0 && trimmed !== "") {
      const withModifier = trimmed.replace(/^(?:@\w+(?:\([^)]*\))?\s+)+/, "");
      const isPrivate = /^(private|fileprivate)\b/.test(withModifier);
      const isPublic = /^public\b/.test(withModifier);
      const bare = withModifier.replace(/^public\s+/, "");
      const type = typeKeyword.exec(bare);
      if (type) {
        topLevel = { kind: type[1], reachable: !isPrivate };
        if (!isPrivate) exported.push(type[2]);
        if (!isPrivate && !isPublic)
          result = result.replace(typeKeyword, (m) => `public ${m}`);
        if (!isPrivate && (type[1] === "struct" || type[1] === "enum"))
          result = sendable(result);
      } else if (/^extension\s/.test(bare)) {
        topLevel = { kind: "extension", reachable: true };
      } else if (!isPrivate && /^(let|var|func|typealias)\b/.test(bare)) {
        const name = /^(?:let|var|func|typealias)\s+(\w+)/.exec(bare);
        if (name) exported.push(name[1]);
        if (!isPublic) result = result.replace(/^(\s*)/, "$1public ");
        topLevel = { kind: "", reachable: false };
      } else {
        topLevel = { kind: "", reachable: false };
      }
    } else if (
      depth === 1 &&
      trimmed !== "" &&
      topLevel.reachable &&
      topLevel.kind !== "protocol"
    ) {
      const bare = trimmed.replace(/^(?:@\w+(?:\([^)]*\))?\s+)+/, "");
      const isPrivate = /^(private|fileprivate|internal|public|open)\b/.test(
        bare.replace(/^(?:(?:static|class|final|nonisolated|override)\s+)*/, "")
      );
      const named = /^(?:struct|enum)\s+CodingKeys\b/.test(bare);
      if (!isPrivate && !named && memberKeyword.test(bare)) {
        // The modifier goes after attributes, before the first keyword.
        result = line.replace(
          /^(\s*)((?:@\w+(?:\([^)]*\))?\s+)*)/,
          (_, space, attributes) => `${space}${attributes}public `
        );
        // A public nested type is no longer Sendable by inference either.
        result = sendable(result);
      } else if (!named) {
        // A nested type written public by hand is no longer Sendable by inference either.
        result = sendable(result);
      }
    }
    for (const ch of plain) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    return result;
  });
  return { exported, text: out.join("\n") };
};

/** Adds `Sendable` to a struct or enum declaration line that does not have it. */
const sendable = (line) => {
  if (!/^\s*public\s+(struct|enum)\b/.test(line) || /\bSendable\b/.test(line))
    return line;
  if (!/\{\s*$/.test(line)) return line;
  return /^[^:{]*:/.test(line)
    ? line.replace(/\s*\{\s*$/, ", Sendable {")
    : line.replace(/\s*\{\s*$/, ": Sendable {");
};

const exported = new Set();
for (const name of kitFiles) {
  const path = join(kitSources, name);
  const before = readFileSync(path, "utf8");
  const { text, exported: names } = publicize(before);
  for (const each of names) exported.add(each);
  write(path, before, text);
}

/** Source text with comments and strings blanked, so a name in prose does not add an import. */
const stripped = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/\/\/.*$/gm, "");

const names = [...exported].sort();
const mentions = new RegExp(`(?<![\\w.])(?:${names.join("|")})\\b`);
const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith(".swift") ? [path] : [];
  });
for (const directory of appDirectories) {
  for (const path of walk(join(apple, directory))) {
    const before = readFileSync(path, "utf8");
    if (/^(?:@testable )?import OrbisKit$/m.test(before)) continue;
    if (!mentions.test(stripped(before))) continue;
    const testable = directory.endsWith("Tests");
    const statement = testable
      ? "@testable import OrbisKit"
      : "import OrbisKit";
    const lines = before.split("\n");
    // Imports stay sorted the way swift-format keeps them: after the last import that sorts before.
    let at = 0;
    for (const [index, line] of lines.entries()) {
      if (/^(?:@testable )?import \w+/.test(line)) {
        const module = line.replace(/^(?:@testable )?import /, "");
        if (module.localeCompare("OrbisKit") < 0) at = index + 1;
        else if (at === 0) at = index;
      }
    }
    lines.splice(at, 0, statement);
    write(path, before, lines.join("\n"));
  }
}
if (check && pending > 0) process.exit(1);
