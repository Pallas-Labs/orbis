#!/usr/bin/env node
// Bounded-read ratchet for Orbis's database reads (PAL-1543), after Möte's
// js-packages/convex/scripts/check-bounded-reads.mjs and the factory's scripts/check-bounded-reads.ts.
//
// SQLite hands the driver every row a query matches, so a read is bounded only when the query
// itself limits the rows. Two shapes are findings:
//
// - drizzle-select: a Drizzle `.select(...)` chain with no `.limit(...)` and no `.get()`, unless it
//   selects aggregates only (`count()`, `max(...)`) with no `.groupBy(...)`, or it is a subquery
//   (`.as(...)`, or an argument of another call).
// - raw-select: a string or template literal that starts with SELECT or WITH, reads FROM a table,
//   and has no LIMIT, unless its columns are aggregates only.
//
// Each finding is keyed by its file, rule and read text, and compared with
// scripts/bounded-reads.baseline.json. A read the baseline does not list fails. A listed read that
// is gone also fails until `--update-baseline` drops it, so the baseline only shrinks;
// `--update-baseline` refuses while a read is new. Mark a read that is bounded another way, such
// as a primary-key lookup or a single-row table, with `// bounded-read: <why>` on the line where
// the read starts or the line above it.
//
//   node scripts/check-bounded-reads.mjs
//   node scripts/check-bounded-reads.mjs --update-baseline
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const baselinePath = path.join(
  repoRoot,
  "scripts",
  "bounded-reads.baseline.json"
);
// The code that reads Orbis's databases: the audio node and the Cloudflare Group.
const roots = ["apps/server/src", "apps/api/src"];
const skippedDirs = new Set(["fixtures", "node_modules"]);
// Tests and their helpers read disposable databases they built themselves.
const sourceFile = /^(?!test-).+(?<!\.test)\.ts$/u;

export const MESSAGES = {
  "drizzle-select":
    "Unbounded read: end the select with .limit(n), read one row with .get(), or select aggregates only. If the read is bounded another way, add `// bounded-read: <why>`.",
  "raw-select":
    "Unbounded read: add LIMIT, or select aggregates only. If the read is bounded another way, add `// bounded-read: <why>`.",
};

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);
const STOPS = new Set([";", ",", "=", "?", ":", "{", "}", "(", "["]);

/** The source with comments and string contents blanked to spaces; offsets and newlines kept. */
export const blankNonCode = (source) => {
  const out = [...source];
  const blank = (from, to) => {
    for (let j = from; j < to; j += 1) {
      if (out[j] !== "\n") {
        out[j] = " ";
      }
    }
  };
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (source[i] === '"' || source[i] === "'" || source[i] === "`") {
      const quote = source[i];
      let j = i + 1;
      while (j < source.length && source[j] !== quote) {
        j += source[j] === "\\" ? 2 : 1;
      }
      blank(i + 1, j);
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return out.join("");
};

/** Where the call chain that holds offset `end` starts: just after the token that opens it. */
const chainStart = (code, end) => {
  let depth = 0;
  for (let i = end - 1; i >= 0; i -= 1) {
    const c = code[i];
    if (CLOSERS.has(c)) {
      depth += 1;
    } else if (OPENERS.has(c) && depth > 0) {
      depth -= 1;
    } else if (
      depth === 0 &&
      (STOPS.has(c) || (c === ">" && code[i - 1] === "="))
    ) {
      return i + 1;
    } else if (
      depth === 0 &&
      /\s/u.test(c) &&
      /\b(?:return|yield\*?|await)\s*$/u.test(code.slice(0, i + 1))
    ) {
      return i + 1;
    }
  }
  return 0;
};

/** The offset just after the matching closer of the opener at `open`. */
const closeOf = (code, open) => {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (OPENERS.has(code[i])) {
      depth += 1;
    } else if (CLOSERS.has(code[i])) {
      depth -= 1;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return code.length;
};

/** The calls `.name(args)` that continue a chain from `from`, and where the chain ends. */
export const chainCalls = (code, from) => {
  const calls = [];
  let at = from;
  for (;;) {
    const match = /^\s*\.\s*(?<name>\w+)\s*(?:<[^>()]*>)?\s*\(/u.exec(
      code.slice(at)
    );
    if (match === null) {
      return { calls, end: at };
    }
    const open = at + match[0].length - 1;
    const close = closeOf(code, open);
    calls.push({
      args: code.slice(open + 1, close - 1),
      name: match.groups.name,
    });
    at = close;
  }
};

// Drizzle's aggregate helpers, or a raw `sql` column such as sql<number>`COUNT(*)`.
const aggregateValue =
  /^\s*(?:(?:count|countDistinct|max|min|sum|avg|sumDistinct|avgDistinct)\s*\(|sql\s*(?:<[^`]*>)?\s*`\s*(?:coalesce\s*\(\s*)?(?:count|max|min|sum|avg|total)\s*\()/iu;

/** True when a select's argument is an object whose every value is an aggregate call. */
const selectsAggregatesOnly = (args, source, offset) => {
  const text = source.slice(offset, offset + args.length).trim();
  if (!text.startsWith("{") || !text.endsWith("}")) {
    return false;
  }
  const values = [];
  let depth = 0;
  let start = 1;
  for (let i = 1; i < text.length - 1; i += 1) {
    const c = text[i];
    if (OPENERS.has(c)) {
      depth += 1;
    } else if (CLOSERS.has(c)) {
      depth -= 1;
    } else if (c === "," && depth === 0) {
      values.push(text.slice(start, i));
      start = i + 1;
    }
  }
  values.push(text.slice(start, -1));
  const entries = values.filter((entry) => entry.trim() !== "");
  return (
    entries.length > 0 &&
    entries.every((entry) => {
      const colon = entry.indexOf(":");
      return colon !== -1 && aggregateValue.test(entry.slice(colon + 1));
    })
  );
};

const lineOf = (code, offset) => code.slice(0, offset).split("\n").length;

const annotatedAt = (lines, line) =>
  lines
    .slice(Math.max(0, line - 2), line)
    .some((text) => /\/\/\s*bounded-read:\s*\S/u.test(text));

const normalize = (text) =>
  text
    .replaceAll(/\s*\.\s*/gu, ".")
    .replaceAll(/\s+/gu, " ")
    .trim();

const drizzleFindings = (source, code, lines) =>
  [...code.matchAll(/\.\s*select(?:Distinct)?\s*\(/gu)].flatMap((match) => {
    const start = chainStart(code, match.index);
    const open = match.index + match[0].length - 1;
    const close = closeOf(code, open);
    const { calls, end } = chainCalls(code, close);
    const names = new Set(calls.map(({ name }) => name));
    if (names.has("limit") || names.has("get") || names.has("as")) {
      return [];
    }
    if (
      !names.has("groupBy") &&
      selectsAggregatesOnly(code.slice(open + 1, close - 1), source, open + 1)
    ) {
      return [];
    }
    // An argument of another call is a subquery, such as `inArray(column, db.select(...))`.
    const before = code.slice(0, start).trimEnd();
    if (before.endsWith("(") || before.endsWith(",")) {
      return [];
    }
    const line = lineOf(code, start);
    if (annotatedAt(lines, line)) {
      return [];
    }
    return [
      {
        line,
        read: normalize(source.slice(start, end)),
        rule: "drizzle-select",
      },
    ];
  });

/** Each string and template literal in `source`, with the line it starts on. */
export const literals = (source) => {
  const found = [];
  let line = 1;
  let index = 0;
  const advance = (to) => {
    for (let j = index; j < to; j += 1) {
      if (source[j] === "\n") {
        line += 1;
      }
    }
    index = to;
  };
  while (index < source.length) {
    const two = source.slice(index, index + 2);
    const char = source[index];
    if (two === "//") {
      const end = source.indexOf("\n", index);
      advance(end === -1 ? source.length : end);
    } else if (two === "/*") {
      const end = source.indexOf("*/", index + 2);
      advance(end === -1 ? source.length : end + 2);
    } else if (char === '"' || char === "'" || char === "`") {
      const start = line;
      let j = index + 1;
      let depth = 0;
      while (j < source.length && (source[j] !== char || depth > 0)) {
        if (source[j] === "\\") {
          j += 2;
        } else {
          if (char === "`" && source.slice(j, j + 2) === "${") {
            depth += 1;
          } else if (depth > 0 && source[j] === "}") {
            depth -= 1;
          }
          j += 1;
        }
      }
      found.push({ line: start, text: source.slice(index + 1, j) });
      advance(Math.min(j + 1, source.length));
    } else {
      advance(index + 1);
    }
  }
  return found;
};

const aggregateColumn = /^(?:count|max|min|sum|avg|total)\s*\(/iu;

/** True when a SELECT's columns are aggregates only, with no GROUP BY: it returns one row. */
const isAggregateRow = (sql) => {
  const columns = /^SELECT\s+(?<columns>[\s\S]*?)\s+FROM\b/iu.exec(sql)?.groups
    ?.columns;
  return (
    columns !== undefined &&
    !/\bGROUP\s+BY\b/iu.test(sql) &&
    columns.split(",").every((column) => aggregateColumn.test(column.trim()))
  );
};

const rawFindings = (source, lines) =>
  literals(source).flatMap(({ line, text }) => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (!/^(?:SELECT|WITH)\s/iu.test(sql) || !/\bFROM\b/iu.test(sql)) {
      return [];
    }
    if (
      /\bLIMIT\b/iu.test(sql) ||
      isAggregateRow(sql) ||
      annotatedAt(lines, line)
    ) {
      return [];
    }
    return [{ line, read: sql, rule: "raw-select" }];
  });

/** The unbounded reads in one file's text; `file` is its path from the repository root. */
export const scanSource = (source, file) => {
  const code = blankNonCode(source);
  const lines = source.split("\n");
  return [
    ...drizzleFindings(source, code, lines),
    ...rawFindings(source, lines),
  ]
    .toSorted((a, b) => a.line - b.line)
    .map((finding) => ({ file, ...finding, message: MESSAGES[finding.rule] }));
};

const keyOf = (file, rule, read) => `${file}\t${rule}\t${read}`;

const countKeys = (entries) => {
  const counts = new Map();
  for (const key of entries) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

const baselineKeys = (baseline) =>
  Object.entries(baseline).flatMap(([file, rules]) =>
    Object.entries(rules).flatMap(([rule, reads]) =>
      reads.map((read) => keyOf(file, rule, read))
    )
  );

/**
 * Findings the baseline does not list. Reads are matched as a multiset by file, rule and text, so
 * bounding one read and adding another in the same file still fails.
 */
export const newFindings = (findings, baseline) => {
  const allowed = countKeys(baselineKeys(baseline));
  return findings.filter(({ file, read, rule }) => {
    const key = keyOf(file, rule, read);
    const left = allowed.get(key) ?? 0;
    allowed.set(key, left - 1);
    return left <= 0;
  });
};

/** Baseline reads that no finding matches: reads someone bounded or removed. */
export const staleReads = (findings, baseline) => {
  const found = countKeys(
    findings.map(({ file, read, rule }) => keyOf(file, rule, read))
  );
  return baselineKeys(baseline).flatMap((key) => {
    const left = found.get(key) ?? 0;
    found.set(key, left - 1);
    if (left > 0) {
      return [];
    }
    const [file, rule, read] = key.split("\t");
    return [{ file, read, rule }];
  });
};

/** The baseline object for a set of findings: file → rule → read texts, sorted by file. */
export const baselineOf = (findings) => {
  const reads = new Map();
  for (const { file, read, rule } of findings) {
    const rules = reads.get(file) ?? {};
    rules[rule] = [...(rules[rule] ?? []), read];
    reads.set(file, rules);
  }
  return Object.fromEntries(
    [...reads].toSorted(([a], [b]) => a.localeCompare(b))
  );
};

const sources = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          return skippedDirs.has(entry.name) ? [] : sources(full);
        }
        return entry.isFile() && sourceFile.test(entry.name) ? [full] : [];
      })
    : [];

/** Every finding in the repository's database code. */
export const scanRepo = (root = repoRoot) =>
  roots
    .flatMap((dir) => sources(path.join(root, dir)))
    .flatMap((file) =>
      scanSource(
        readFileSync(file, "utf-8"),
        path.relative(root, file).split(path.sep).join("/")
      )
    );

const writeBaseline = (baseline) =>
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);

const main = () => {
  const findings = scanRepo();
  if (!existsSync(baselinePath)) {
    writeBaseline(baselineOf(findings));
    console.log(
      `bounded reads: first baseline written, ${findings.length} finding(s)`
    );
    return;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf-8"));
  const offenders = newFindings(findings, baseline);
  if (offenders.length > 0) {
    for (const finding of offenders) {
      console.error(
        `${finding.file}:${finding.line} ${finding.rule}: ${finding.message}\n  ${finding.read}`
      );
    }
    console.error(
      `\nbounded reads: ${offenders.length} new unbounded read(s) beyond scripts/bounded-reads.baseline.json`
    );
    process.exitCode = 1;
    return;
  }
  const stale = staleReads(findings, baseline);
  if (process.argv.includes("--update-baseline")) {
    const next = baselineOf(findings);
    writeBaseline(next);
    console.log(
      `bounded reads: baseline written, ${stale.length} read(s) dropped, ${findings.length} left in ${Object.keys(next).length} files`
    );
    return;
  }
  if (stale.length > 0) {
    for (const { file, read, rule } of stale) {
      console.error(
        `${file}: the baseline lists a ${rule} read that is gone\n  ${read}`
      );
    }
    console.error(
      "\nbounded reads: the baseline only shrinks; run `node scripts/check-bounded-reads.mjs --update-baseline` to drop these"
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `bounded reads: ok, ${findings.length} known finding(s) held at the baseline`
  );
};

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
