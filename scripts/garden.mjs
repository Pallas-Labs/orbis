// Measures the repository for the scheduled gardening run and prints one schema-1 JSON
// record. It reads the working tree of the Git repository that contains the current
// directory, needs no network, secrets, or env files, and finishes in seconds.
//
// Usage:
//   node scripts/garden.mjs                         print the measurement as JSON
//   node scripts/garden.mjs --with-gate             also run each `bun run check` task and time it
//   node scripts/garden.mjs --out <file>            also write the JSON to <file>
//   node scripts/garden.mjs --compare <prev.json>   print a Markdown summary against an earlier run
//
// AGENTS.md lists what each metric counts. A metric that needs macOS or a missing tool is
// reported in `skipped` with a reason; it never fails the run. A finding's id depends on its
// kind, its file, and its normalized text, never on its line, so a finding that only moves
// keeps its id.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const SCHEMA = 1;
const HISTORY_DAYS = 14;
const LIST_LIMIT = 20;

// Records and generated code that gardening never edits: audit trails, dated plans, audits,
// and research notes, generated route trees, the shadcn components oxlint.config.ts also
// ignores, and this sensor, whose patterns and test fixtures would otherwise count themselves.
const EXCLUDED = [
  /^\.audit\//u,
  /^docs\/(?:plans|audits|research)\//u,
  /^apps\/web\/src\/components\/(?:ui|ai-elements)\//u,
  /^scripts\/garden(?:\.test)?\.mjs$/u,
  /\.gen\.ts$/u,
  /(?:^|\/)bun\.lock$/u,
];

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".mts",
  ".sh",
  ".sql",
  ".swift",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const SCRIPT_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const TYPESCRIPT_EXTENSIONS = new Set([".mts", ".ts", ".tsx"]);

const isTestFile = (file) =>
  /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file) ||
  /(?:^|\/)e2e\//u.test(file) ||
  (file.endsWith(".swift") && /(?:^|\/)\w*Tests\//u.test(file));

const SUPPRESSION =
  /(?:\/\/|\/\*|^\s*\*|#|\{\/\*|<!--)\s*(?:(?:eslint|oxlint)-disable(?:-next-line|-line)?|oxlint-ignore|biome-ignore|@ts-(?:ignore|expect-error|nocheck)|@effect-diagnostics(?:-next-line)?|(?:oxfmt|prettier)-ignore|swiftlint:disable(?::next|:this)?|swift-format-ignore(?:-file)?|periphery:ignore|shellcheck\s+disable)\b/u;
const MARKER = /\b(?:TODO|FIXME|HACK|XXX)\b(?=\s*[:(])/u;
const TS_ASSERTION =
  /\bas\s+(?!const\b)(?:[A-Z_$]|unknown\b|any\b|never\b|string\b|number\b|boolean\b|object\b|readonly\b|typeof\b|keyof\b|[{[(])/u;
const TS_NON_NULL = /(?<=[\w$)\]])!(?![=!])(?=[.[)\],;:]|$)/u;
const TS_IMPORT_SPECIFIER =
  /^\s*import\b|^\s*export\s+(?:type\s+)?[*{]|^\s*[\w$]+\s+as\s+[\w$]+,?\s*$/u;
const SWIFT_FORCE = /\btry!|\bas!|(?<=[\w)\]])!(?![=!])(?=[.[(),:;\s]|$)/u;
const SKIPPED_TEST =
  /\b(?:describe|it|test|suite)\.(?:skip|todo|skipIf|todoIf)\b|\bx(?:describe|it|test)\(|[{,]\s*(?:skip|todo)\s*:\s*(?!false\b)|\bt\.(?:skip|todo)\(|\bXCTSkip(?:If|Unless)?\b|\.disabled\(/u;
const FOCUSED_TEST =
  /\b(?:describe|it|test|suite)\.only\b|\bf(?:describe|it)\(|[{,]\s*only\s*:\s*true\b/u;

const metric = (id, value, command, unit = "count") => ({
  command,
  id,
  unit,
  value,
});

const roundSeconds = (milliseconds) => Math.round(milliseconds / 100) / 10;

const normalize = (text) => text.trim().replaceAll(/\s+/gu, " ");

// Removes string literals and line comments so that code patterns do not match prose.
const codeOf = (line) => {
  const trimmed = line.trim();
  if (trimmed.startsWith("*") || trimmed.startsWith("/*")) {
    return "";
  }
  return line
    .replaceAll(/`(?:\\.|[^`\\])*`/gu, "``")
    .replaceAll(/"(?:\\.|[^"\\])*"/gu, '""')
    .replaceAll(/'(?:\\.|[^'\\])*'/gu, "''")
    .replace(/\/\/.*$/u, "");
};

const run = (root, command, args) =>
  spawnSync(command, args, {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
  });

const git = (root, args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
  });

const isFile = (file) =>
  statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;

const trackedFiles = (root) =>
  git(root, ["ls-files", "-z"])
    .split("\0")
    .filter((file) => file.length > 0);

// Every tracked file and the directories that hold one, so that a reference resolves the same
// on every checkout whatever untracked files it has.
const trackedPaths = (tracked) => {
  const paths = new Set();
  for (const file of tracked) {
    for (let entry = file; entry !== "."; entry = path.dirname(entry)) {
      paths.add(entry);
    }
  }
  return paths;
};

const isSource = (file) =>
  SCRIPT_EXTENSIONS.has(path.extname(file)) || file.endsWith(".swift");

const finding = (kind, file, line, text, detail = text) => ({
  detail,
  file,
  kind,
  line,
  text: normalize(text),
});

// Comment kinds, which every text file can hold.
const scanComments = (file, lines) =>
  lines.flatMap((line, index) => [
    ...(SUPPRESSION.test(line)
      ? [finding("suppression", file, index + 1, line)]
      : []),
    ...(MARKER.test(line) ? [finding("marker", file, index + 1, line)] : []),
  ]);

const scanSource = (file, lines) => {
  const extension = path.extname(file);
  const found = [];
  const testFile = isTestFile(file);
  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    const code = codeOf(line);
    if (
      TYPESCRIPT_EXTENSIONS.has(extension) &&
      !TS_IMPORT_SPECIFIER.test(code) &&
      (TS_ASSERTION.test(code) || TS_NON_NULL.test(code))
    ) {
      found.push(finding("type-assertion", file, number, line));
    }
    if (extension === ".swift" && SWIFT_FORCE.test(code)) {
      found.push(finding("force-operation", file, number, line));
    }
    if (testFile && SKIPPED_TEST.test(code)) {
      found.push(finding("skipped-test", file, number, line));
    }
    if (testFile && FOCUSED_TEST.test(code)) {
      found.push(finding("focused-test", file, number, line));
    }
  }
  return found;
};

const SCRIPT_COMMAND =
  /\b(?:bun|npm|pnpm|yarn)\s+run\s+(?<filters>(?:--filter[= ]\S+\s+)*)(?<script>[^\s`'"();]+)/gu;

const packageScripts = (files) =>
  files
    .filter(({ file }) => path.basename(file) === "package.json")
    .map(({ file, lines }) => {
      const manifest = JSON.parse(lines.join("\n"));
      return {
        dir: path.dirname(file),
        file,
        name: manifest.name,
        scripts: new Set(Object.keys(manifest.scripts ?? {})),
      };
    });

const staleScript = (packages, filters, script) => {
  if (
    script.startsWith("-") ||
    script.includes("/") ||
    /\.[cm]?[jt]sx?$/u.test(script)
  ) {
    return null;
  }
  const names = [...filters.matchAll(/--filter[= ](?<name>\S+)/gu)].map(
    (match) => match.groups.name.replaceAll(/^["']|["']$/gu, "")
  );
  if (names.length === 0) {
    return packages.some((entry) => entry.scripts.has(script))
      ? null
      : `no package.json defines the script \`${script}\``;
  }
  for (const name of names) {
    const target = packages.find(
      (entry) => entry.name === name || entry.dir === path.normalize(name)
    );
    if (!target) {
      return `no workspace is named \`${name}\``;
    }
    if (!target.scripts.has(script)) {
      return `${target.file} has no script \`${script}\``;
    }
  }
  return null;
};

const PATH_TOKEN = /^(?:\.{1,2}\/)?[\w.@-]+(?:\/[\w.@+-]+)*\/?$/u;

// A token claims a repository path when it starts with ./ or ../, or when its first segment
// exists at the root or beside the document. Other slashed words, such as MIME types or Forge
// pages, are not repository paths.
const pathClaim = (known, documentDir, token) => {
  const cleaned = token
    .replaceAll(/^["'(]+|["'),.;]+$/gu, "")
    .replace(/#.*$/u, "")
    .replace(/:\d+(?:-\d+)?$/u, "");
  if (
    !cleaned.includes("/") ||
    cleaned.includes("://") ||
    !PATH_TOKEN.test(cleaned)
  ) {
    return null;
  }
  const relative = cleaned.startsWith("./") || cleaned.startsWith("../");
  const [first] = cleaned.split("/");
  const fromRoot = path.normalize(cleaned).replace(/\/$/u, "");
  const fromDocument = path.join(documentDir, cleaned).replace(/\/$/u, "");
  if (known.has(fromRoot) || known.has(fromDocument)) {
    return null;
  }
  if (fromDocument.startsWith("..")) {
    return null;
  }
  if (relative || known.has(path.join(documentDir, first))) {
    return { claimed: fromDocument, token: cleaned };
  }
  if (known.has(first)) {
    return { claimed: fromRoot, token: cleaned };
  }
  return null;
};

const SHELL_FENCES = new Set([
  "",
  "bash",
  "console",
  "fish",
  "sh",
  "shell",
  "zsh",
]);

const scanDocument = (known, packages, file, lines) => {
  const documentDir = path.dirname(file);
  const scripts = [];
  const paths = [];
  let fence = null;
  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    const fenceMatch = /^\s*(?:```+|~~~+)\s*(?<info>[\w-]*)/u.exec(line);
    if (fenceMatch) {
      fence = fence === null ? fenceMatch.groups.info.toLowerCase() : null;
      continue;
    }
    if (fence !== null && !SHELL_FENCES.has(fence)) {
      continue;
    }
    const spans =
      fence === null
        ? [...line.matchAll(/`(?<code>[^`]+)`/gu)].map(
            (match) => match.groups.code
          )
        : [line];
    for (const span of spans) {
      for (const match of span.matchAll(SCRIPT_COMMAND)) {
        const reason = staleScript(
          packages,
          match.groups.filters,
          match.groups.script
        );
        if (reason) {
          scripts.push(
            finding("stale-doc-ref", file, number, match[0], reason)
          );
        }
      }
      for (const token of span.split(/\s+/u)) {
        const claim = pathClaim(known, documentDir, token);
        if (claim) {
          paths.push({ claim, number });
        }
      }
    }
  }
  return { paths, scripts };
};

// Paths that .gitignore covers are build output the docs describe, not stale references.
// Each path is also checked as a directory, which directory-only patterns need. Git stops a
// whole batch at a path beyond a symlink, so each form gets its own call.
const isIgnored = (root, candidate) =>
  [candidate, `${candidate}/`].some(
    (form) =>
      spawnSync("git", ["check-ignore", "--quiet", "--no-index", form], {
        cwd: root,
      }).status === 0
  );

const ignoredPaths = (root, candidates) =>
  new Set(
    [...new Set(candidates)].filter((candidate) => isIgnored(root, candidate))
  );

const scanDocuments = (root, files, known) => {
  const packages = packageScripts(files);
  const scanned = files
    .filter(({ file }) => file.endsWith(".md"))
    .map(({ file, lines }) => ({
      file,
      ...scanDocument(known, packages, file, lines),
    }));
  const ignored = ignoredPaths(
    root,
    scanned.flatMap((entry) => entry.paths.map(({ claim }) => claim.claimed))
  );
  return scanned.flatMap((entry) => [
    ...entry.scripts,
    ...entry.paths
      .filter(({ claim }) => !ignored.has(claim.claimed))
      .map(({ claim, number }) =>
        finding(
          "stale-doc-ref",
          entry.file,
          number,
          claim.token,
          `\`${claim.token}\` does not exist (${claim.claimed})`
        )
      ),
  ]);
};

const DEAD_CODE_RULES =
  /\(no-unused-(?:vars|private-class-members|labels|expressions)\)$|unused-imports/u;

const skippedPart = (ids, reason, skipped = []) => ({
  findings: [],
  metrics: [],
  skipped: [...skipped, ...ids.map((id) => ({ id, reason }))],
});

const LINT_IDS = ["lint.errors", "lint.warnings", "deadcode.unused"];

const measureLint = (root) => {
  const binary = path.join(root, "node_modules/.bin/oxlint");
  const command = "oxlint . -f json";
  if (!existsSync(binary)) {
    return skippedPart(LINT_IDS, "oxlint is not installed; run bun install");
  }
  const result = run(root, binary, [".", "-f", "json"]);
  let report = null;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    return skippedPart(
      LINT_IDS,
      `oxlint printed no JSON (exit ${result.status})`
    );
  }
  const diagnostics = report.diagnostics ?? [];
  const findings = diagnostics.map((diagnostic) => {
    const kind = DEAD_CODE_RULES.test(diagnostic.code ?? "")
      ? "dead-code"
      : "lint";
    const text = `${diagnostic.code}: ${diagnostic.message}`;
    return finding(
      kind,
      diagnostic.filename,
      diagnostic.labels?.[0]?.span?.line ?? 0,
      text,
      `${diagnostic.severity} ${text}`
    );
  });
  const count = (predicate) => diagnostics.filter(predicate).length;
  return {
    findings,
    metrics: [
      metric(
        "lint.errors",
        count((item) => item.severity === "error"),
        command
      ),
      metric(
        "lint.warnings",
        count((item) => item.severity === "warning"),
        command
      ),
      metric(
        "deadcode.unused",
        count((item) => DEAD_CODE_RULES.test(item.code ?? "")),
        `${command}, unused-code rules`
      ),
    ],
    skipped: [],
  };
};

// Runs the root `native:format` script's command, which is the Swift style gate.
const measureSwift = (root, manifest) => {
  const unused = [
    {
      id: "swift.unused",
      reason:
        "the repo configures no Swift dead-code tool; Swift builds need macOS",
    },
  ];
  if (process.platform !== "darwin") {
    return skippedPart(
      ["swift.format"],
      "needs macOS (xcrun swift-format)",
      unused
    );
  }
  const command = manifest.scripts?.["native:format"];
  if (!command) {
    return skippedPart(
      ["swift.format"],
      "package.json has no native:format script",
      unused
    );
  }
  const [binary, ...args] = command.split(/\s+/u);
  const result = run(root, binary, args);
  if (result.error) {
    return skippedPart(["swift.format"], `${binary} failed to start`, unused);
  }
  const warnings = result.stderr
    .split("\n")
    .map((line) =>
      /^(?<file>[^:]+):(?<line>\d+):\d+: (?:warning|error): (?<message>.*)$/u.exec(
        line
      )
    )
    .filter(Boolean)
    .map((match) =>
      finding(
        "lint",
        path.relative(root, path.resolve(root, match.groups.file)),
        Number(match.groups.line),
        `swift-format: ${match.groups.message}`
      )
    );
  return {
    findings: warnings,
    metrics: [metric("swift.format", warnings.length, command)],
    skipped: unused,
  };
};

const measureHistory = (root) => {
  const headDate = new Date(git(root, ["log", "-1", "--format=%cI"]).trim());
  const since = new Date(
    headDate.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000
  );
  const log = git(root, [
    "log",
    `--since=${since.toISOString()}`,
    "--no-merges",
    "--format=%H%x1f%s",
    "HEAD",
  ]);
  const reverts = [];
  const workarounds = [];
  for (const entry of log.split("\n").filter((line) => line.length > 0)) {
    const [sha, subject] = entry.split("\u001F");
    const short = sha.slice(0, 12);
    if (/^Revert\b/iu.test(subject)) {
      reverts.push(
        finding("history", `git:${short}`, 0, subject, `revert: ${subject}`)
      );
    } else if (/work[\s-]?around|flak(?:y|e)/iu.test(subject)) {
      workarounds.push(
        finding("history", `git:${short}`, 0, subject, `workaround: ${subject}`)
      );
    }
  }
  const command = `git log --no-merges --since=<HEAD date - ${HISTORY_DAYS} days>`;
  return {
    findings: [...reverts, ...workarounds],
    metrics: [
      metric(
        "history.reverts",
        reverts.length,
        `${command}, subjects starting with Revert`
      ),
      metric(
        "history.workarounds",
        workarounds.length,
        `${command}, subjects naming a workaround or flaky test`
      ),
    ],
    skipped: [],
  };
};

// The tasks the root `check` script hands to `turbo run`, in order.
const gateTasks = (manifest) => {
  const words = (manifest.scripts?.check ?? "").split(/\s+/u);
  const start = words.findIndex(
    (word, index) => word === "run" && words[index - 1] === "turbo"
  );
  if (start === -1) {
    return [];
  }
  const rest = words.slice(start + 1);
  const end = rest.findIndex((word) => word.startsWith("-"));
  return end === -1 ? rest : rest.slice(0, end);
};

const lastLine = (result) =>
  `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line.length > 0)
    ?.slice(0, 200) ?? "no output";

const measureGate = (root, manifest) => {
  const turbo = path.join(root, "node_modules/.bin/turbo");
  const skipped =
    process.platform === "darwin"
      ? []
      : [
          {
            id: "gate.native",
            reason: "the native lanes need macOS and a simulator",
          },
        ];
  if (!existsSync(turbo)) {
    return skippedPart(
      ["gate"],
      "turbo is not installed; run bun install",
      skipped
    );
  }
  const metrics = [];
  const findings = [];
  for (const task of gateTasks(manifest)) {
    const args = ["run", task, "--force", "--output-logs=errors-only"];
    const started = performance.now();
    const result = run(root, turbo, args);
    const seconds = roundSeconds(performance.now() - started);
    metrics.push(
      metric(
        `gate.${task}.seconds`,
        seconds,
        `turbo ${args.join(" ")}`,
        "seconds"
      )
    );
    if (result.status !== 0) {
      findings.push(
        finding(
          "gate-failure",
          "package.json",
          0,
          `turbo run ${task}`,
          `turbo run ${task} exited ${result.status}: ${lastLine(result)}`
        )
      );
    }
  }
  metrics.push(
    metric("gate.failures", findings.length, "turbo run <check task> --force")
  );
  return { findings, metrics, skipped };
};

const COUNTED_KINDS = [
  [
    "suppressions",
    "suppression",
    "lint, type, format, and Swift suppression comments",
  ],
  [
    "typescript.assertions",
    "type-assertion",
    "`as` (not `as const`) and `!` in TypeScript code",
  ],
  [
    "swift.force-operations",
    "force-operation",
    "`try!`, `as!`, and force unwraps in Swift",
  ],
  [
    "tests.skipped",
    "skipped-test",
    "skipped or todo tests, XCTSkip, and .disabled traits",
  ],
  ["tests.focused", "focused-test", ".only tests and fit/fdescribe"],
  [
    "docs.stale-refs",
    "stale-doc-ref",
    "missing paths and scripts named in Markdown",
  ],
  ["markers", "marker", "TODO:, FIXME:, HACK:, and XXX: markers"],
];

// Code-unit order, which does not depend on the machine's locale.
const order = (a, b) => (a < b ? -1 : Number(a > b));

// Identical text in one file gets an occurrence suffix, counted in line order.
const withIds = (findings) => {
  const sorted = findings.toSorted(
    (a, b) => order(a.kind, b.kind) || order(a.file, b.file) || a.line - b.line
  );
  const seen = new Map();
  return sorted.map(({ detail, file, kind, line, text }) => {
    const hash = createHash("sha256")
      .update(`${kind}\0${file}\0${text}`)
      .digest("hex");
    const occurrence = (seen.get(hash) ?? 0) + 1;
    seen.set(hash, occurrence);
    const id = `${kind}:${hash.slice(0, 12)}${occurrence > 1 ? `~${occurrence}` : ""}`;
    return { detail: normalize(detail), id, kind, line, location: file };
  });
};

export const measure = (root, { withGate = false } = {}) => {
  const started = performance.now();
  const tracked = trackedFiles(root);
  const files = tracked
    .filter(
      (file) =>
        !EXCLUDED.some((pattern) => pattern.test(file)) &&
        TEXT_EXTENSIONS.has(path.extname(file)) &&
        isFile(path.join(root, file))
    )
    .map((file) => ({
      file,
      lines: readFileSync(path.join(root, file), "utf-8").split("\n"),
    }));
  const rootManifest = files.find(({ file }) => file === "package.json");
  const manifest = rootManifest
    ? JSON.parse(rootManifest.lines.join("\n"))
    : {};
  const scanned = [
    ...files.flatMap(({ file, lines }) => scanComments(file, lines)),
    ...files
      .filter(({ file }) => isSource(file))
      .flatMap(({ file, lines }) => scanSource(file, lines)),
    ...scanDocuments(root, files, trackedPaths(tracked)),
  ];
  const lint = measureLint(root);
  const swift = measureSwift(root, manifest);
  const history = measureHistory(root);
  const gate = withGate ? measureGate(root, manifest) : skippedPart([], "");
  const parts = [lint, swift, history, gate];
  const counted = COUNTED_KINDS.map(([id, kind, command]) =>
    metric(id, scanned.filter((item) => item.kind === kind).length, command)
  );
  return {
    commit: git(root, ["rev-parse", "HEAD"]).trim(),
    findings: withIds([...scanned, ...parts.flatMap((part) => part.findings)]),
    measuredAt: new Date().toISOString(),
    metrics: [
      ...lint.metrics,
      ...counted,
      ...swift.metrics,
      ...history.metrics,
      ...gate.metrics,
      metric(
        "sensor.seconds",
        roundSeconds(performance.now() - started),
        "node scripts/garden.mjs",
        "seconds"
      ),
    ],
    repo: manifest.name ?? path.basename(root),
    schema: SCHEMA,
    skipped: parts.flatMap((part) => part.skipped),
  };
};

const short = (commit) => (commit ? commit.slice(0, 12) : "none");

const formatNumber = (value) => (value === undefined ? "—" : String(value));

const formatChange = (before, after) => {
  if (before === undefined || after === undefined) {
    return "—";
  }
  const change = Math.round((after - before) * 10) / 10;
  return change > 0 ? `+${change}` : String(change);
};

const listFindings = (title, items) => {
  const lines = [`#### ${title} (${items.length})`, ""];
  for (const item of items.slice(0, LIST_LIMIT)) {
    const where =
      item.line > 0 ? `${item.location}:${item.line}` : item.location;
    lines.push(`- ${item.kind} \`${where}\`: ${item.detail} (\`${item.id}\`)`);
  }
  if (items.length > LIST_LIMIT) {
    lines.push(`- …and ${items.length - LIST_LIMIT} more`);
  }
  if (items.length === 0) {
    lines.push("- none");
  }
  return lines;
};

export const compare = (previous, current) => {
  if (previous.schema !== SCHEMA) {
    throw new Error(
      `The previous run has schema ${previous.schema}, not ${SCHEMA}.`
    );
  }
  const before = new Map(previous.metrics.map((item) => [item.id, item.value]));
  const after = new Map(current.metrics.map((item) => [item.id, item.value]));
  const ids = [...new Set([...after.keys(), ...before.keys()])];
  const previousIds = new Set(previous.findings.map((item) => item.id));
  const currentIds = new Set(current.findings.map((item) => item.id));
  const lines = [
    `### Gardening sensor: \`${short(current.commit)}\` against \`${short(previous.commit)}\``,
    "",
    "| Metric | Previous | Current | Change |",
    "| --- | ---: | ---: | ---: |",
    ...ids.map(
      (id) =>
        `| ${id} | ${formatNumber(before.get(id))} | ${formatNumber(after.get(id))} | ${formatChange(before.get(id), after.get(id))} |`
    ),
    "",
  ];
  if (current.skipped.length > 0) {
    lines.push(
      `Skipped: ${current.skipped.map((item) => `\`${item.id}\` (${item.reason})`).join(", ")}.`,
      ""
    );
  }
  lines.push(
    ...listFindings(
      "New findings",
      current.findings.filter((item) => !previousIds.has(item.id))
    ),
    "",
    ...listFindings(
      "Repeated findings",
      current.findings.filter((item) => previousIds.has(item.id))
    ),
    "",
    ...listFindings(
      "Resolved findings",
      previous.findings.filter((item) => !currentIds.has(item.id))
    )
  );
  return `${lines.join("\n")}\n`;
};

export const main = (argv = process.argv.slice(2)) => {
  const { values } = parseArgs({
    args: argv,
    options: {
      compare: { type: "string" },
      out: { type: "string" },
      "with-gate": { type: "boolean" },
    },
  });
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const previous = values.compare
    ? JSON.parse(readFileSync(path.resolve(values.compare), "utf-8"))
    : null;
  const current = measure(root, { withGate: values["with-gate"] ?? false });
  const json = `${JSON.stringify(current, null, 2)}\n`;
  if (values.out) {
    writeFileSync(path.resolve(values.out), json);
  }
  process.stdout.write(previous ? compare(previous, current) : json);
  return 0;
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
