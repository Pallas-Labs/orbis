import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  deadGlobs,
  declaredTypes,
  globPattern,
  scopeProblems,
  testsOf,
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

const tv = {
  paths: ["apps/apple/Orbis/TV/**"],
  platform: "tvos",
  tests: ["OrbisTVUITests"],
};
const player = new Map([
  ["apps/apple/Orbis/AudioPlayer.swift", "final class AudioPlayer {}\n"],
  [
    "apps/apple/Orbis/TV/TVNowPlaying.swift",
    "struct TVNowPlaying {\n  let player: AudioPlayer\n}\n",
  ],
]);

test("asks a file that only the iOS fallback matches for the tvOS tests its types reach", () => {
  assert.deepEqual(scopeProblems({ rules: [tv, fallback] }, player), [
    "apps/apple/Orbis/AudioPlayer.swift needs OrbisTVUITests: AudioPlayer in apps/apple/Orbis/TV/TVNowPlaying.swift uses a type it declares",
  ]);
  const shared = {
    paths: ["apps/apple/Orbis/AudioPlayer.swift"],
    platform: "tvos",
    tests: ["OrbisTVUITests"],
  };
  assert.deepEqual(
    scopeProblems({ rules: [tv, shared, fallback] }, player),
    []
  );
});

test("asks nothing for a use in a file whose named rule names the fallback's tests", () => {
  const shell = rule(["apps/apple/Orbis/Shell.swift"], ["OrbisUITests"]);
  const used = new Map([
    ...files,
    ["apps/apple/Orbis/Shell.swift", "ErrorText()"],
  ]);
  assert.deepEqual(
    scopeProblems({ rules: [arrive, shell, fallback] }, used),
    []
  );
});

test("reports a glob that matches no file", () => {
  assert.deepEqual(
    deadGlobs({ ignore: ["docs/**"], rules: [arrive, table] }, [
      "apps/apple/Orbis/Arrive/ArriveForm.swift",
      "docs/a.md",
    ]),
    ["apps/apple/Orbis/Table/**"]
  );
});

test("sends a change to shared app code to an iOS test and to OrbisTVUITests", () => {
  const scope = JSON.parse(fs.readFileSync("simulator-scope.json", "utf-8"));
  const audio = testsOf(scope, "apps/apple/Orbis/AudioPlayer.swift");
  assert.ok(audio.ios.includes("OrbisUITests/PlaybackUITests"));
  assert.deepEqual(audio.tvos, ["OrbisTVUITests"]);
  // A named tvOS rule hides the iOS fallback, so the shared shell keeps every iOS test by name.
  assert.deepEqual(testsOf(scope, "apps/apple/Orbis/AppModel.swift"), {
    ios: ["OrbisUITests"],
    tvos: ["OrbisTVUITests"],
  });
  assert.deepEqual(
    testsOf(scope, "apps/apple/OrbisKit/Sources/OrbisKit/X.swift"),
    {
      ios: ["OrbisUITests"],
      tvos: ["OrbisTVUITests"],
    }
  );
  // An iPhone-only screen, left out of the tvOS build, runs no tvOS test.
  assert.deepEqual(
    Object.keys(testsOf(scope, "apps/apple/Orbis/SetDetailScreen.swift")),
    ["ios"]
  );
});
