import assert from "node:assert/strict";
import { test } from "node:test";

import {
  declaredTypes,
  globPattern,
  scopeProblems,
} from "./check-simulator-scope.mjs";

const rule = (paths, tests) => ({ paths, platform: "ios", tests });
const fallback = {
  fallback: true,
  paths: ["apps/apple/**"],
  platform: "ios",
  tests: ["OrbisUITests"],
};
const arrive = rule(
  ["apps/apple/Orbis/Arrive/**"],
  ["OrbisUITests/CheckInUITests"]
);
const table = rule(
  ["apps/apple/Orbis/Table/**"],
  ["OrbisUITests/TableUITests"]
);
const files = new Map([
  [
    "apps/apple/Orbis/Arrive/ArriveForm.swift",
    "struct ErrorText: View {}\nprivate struct Hidden {}\n",
  ],
  [
    "apps/apple/Orbis/Table/TableView.swift",
    "struct TableView: View {\n  var body: some View { ErrorText() }\n}\n",
  ],
]);

test("reads top-level types that are not private", () => {
  const source =
    "@MainActor\nfinal class Model {}\nprivate enum Local {}\nstruct Outer {\n  struct Inner {}\n}\n";
  assert.deepEqual(declaredTypes(source), ["Model", "Outer"]);
});

test("matches globs the way factory journeys does", () => {
  assert.ok(
    globPattern("apps/apple/Orbis/Arrive/**").test(
      "apps/apple/Orbis/Arrive/A/B.swift"
    )
  );
  assert.ok(
    !globPattern("apps/apple/OrbisUITests/*UITests.swift").test(
      "apps/apple/OrbisUITests/x/AUITests.swift"
    )
  );
});

test("asks a rule for the tests of every rule whose files use its types", () => {
  assert.deepEqual(scopeProblems({ rules: [arrive, table, fallback] }, files), [
    "apps/apple/Orbis/Arrive/ArriveForm.swift needs OrbisUITests/TableUITests: ErrorText in apps/apple/Orbis/Table/TableView.swift uses a type it declares",
  ]);
});

test("counts every rule that matches the declaring file", () => {
  const shared = rule(
    ["apps/apple/Orbis/Arrive/ArriveForm.swift"],
    ["OrbisUITests"]
  );
  assert.deepEqual(
    scopeProblems({ rules: [arrive, shared, table, fallback] }, files),
    []
  );
});

test("asks nothing for a use in a file that only the fallback matches", () => {
  const root = new Map([
    ...files,
    ["apps/apple/Orbis/RootView.swift", "ErrorText()"],
  ]);
  assert.deepEqual(scopeProblems({ rules: [arrive, fallback] }, root), []);
});

test("ignores a name in a comment and a name the using file declares itself", () => {
  const quiet = new Map([
    ...files,
    [
      "apps/apple/Orbis/Table/TableView.swift",
      "// ErrorText is Arrive's\nstruct TableView {}\n",
    ],
    [
      "apps/apple/Orbis/Table/Own.swift",
      "struct ErrorText {}\nlet x = ErrorText()\n",
    ],
  ]);
  assert.deepEqual(
    scopeProblems({ rules: [arrive, table, fallback] }, quiet),
    []
  );
});

test("asks an ignored file for the tests its types reach", () => {
  const bulk = new Map([
    ...files,
    ["apps/apple/Orbis/BulkImport.swift", "struct BulkRow {}\n"],
    ["apps/apple/Orbis/Table/List.swift", "BulkRow()"],
  ]);
  assert.deepEqual(
    scopeProblems(
      {
        ignore: ["apps/apple/Orbis/BulkImport*.swift"],
        rules: [arrive, table, fallback],
      },
      bulk
    ).slice(-1),
    [
      "apps/apple/Orbis/BulkImport.swift needs OrbisUITests/TableUITests: BulkRow in apps/apple/Orbis/Table/List.swift uses a type it declares",
    ]
  );
});
