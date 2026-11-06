import { antipattern, correctness } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";

const TEST_FILES = ["**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}"];
// Test journeys and fixtures that drive the app from outside, like tests.
const TEST_CODE = [...TEST_FILES, "**/e2e/**", "**/evals/**"];
// Code that runs inside a server process, a Worker isolate or a browser tab.
const RUNTIME_SOURCES = ["apps/*/src/**", "packages/*/src/**"];
// Ultracite's type-aware rules that never ran before type-aware lint (PAL-1543) and report today.
// PAL-1681 turns each one on or gives it a reason; the others, which pass, stay on.
const ULTRACITE_TYPE_AWARE_DEBT = [
  "typescript/await-thenable",
  "typescript/consistent-return",
  "typescript/no-base-to-string",
  "typescript/no-confusing-void-expression",
  "typescript/no-deprecated",
  "typescript/no-floating-promises",
  "typescript/no-misused-promises",
  "typescript/no-misused-spread",
  "typescript/no-unnecessary-boolean-literal-compare",
  "typescript/no-unnecessary-type-arguments",
  "typescript/no-unnecessary-type-conversion",
  "typescript/no-unnecessary-type-parameters",
  "typescript/no-unsafe-argument",
  "typescript/no-unsafe-assignment",
  "typescript/no-unsafe-call",
  "typescript/no-unsafe-member-access",
  "typescript/no-unsafe-return",
  "typescript/no-unsafe-type-assertion",
  "typescript/only-throw-error",
  "typescript/prefer-nullish-coalescing",
  "typescript/promise-function-async",
  "typescript/require-array-sort-compare",
  "typescript/restrict-template-expressions",
  "typescript/return-await",
  "typescript/strict-boolean-expressions",
  "typescript/strict-void-return",
  "typescript/switch-exhaustiveness-check",
];

export default defineConfig({
  extends: [core, antiSlop],
  ignorePatterns: [
    ...core.ignorePatterns,
    // shadcn generates these; `shadcn add` overwrites any hand edits.
    "apps/web/src/components/ui/**",
    "apps/web/src/components/ai-elements/**",
    // Vendored upstream plugin source; fix it upstream, not here.
    "lint-plugins/t3code/**",
    // Each fixture holds the findings its rule must report; scripts/fence.test.mjs checks them.
    "lint-plugins/orbis/fixtures/**",
    "scripts/fixtures/effect-diagnostics/**",
  ],
  // Vendored from t3code; see lint-plugins/t3code/README.md. The orbis plugin is the rat-stack
  // fence (PAL-1543); see lint-plugins/orbis/index.mjs.
  jsPlugins: [
    "./lint-plugins/t3code/index.ts",
    "./lint-plugins/orbis/index.mjs",
  ],
  // A suppression that no longer hides a diagnostic is noise; delete it.
  options: { reportUnusedDisableDirectives: "error", typeAware: true },
  overrides: [
    {
      // Effect's type-aware rules from @effect/tsgo, run by the patched oxlint-tsgolint.
      files: ["apps/**", "packages/**", "scripts/**"],
      plugins: correctness.plugins,
      rules: {
        ...correctness.rules,
        ...antipattern.rules,
        // tsconfig.base.json lists the unstable Effect modules Orbis allows, and tsc enforces
        // that list; this rule reads no tsconfig for files outside a project, such as e2e.
        "effecttsgo/unstable-api-usage": "off",
      },
    },
    {
      // Entry points and bridges build and provide their own layers: tests, journeys, one-off
      // jobs, and the web and Raycast clients' `run`.
      files: [
        ...TEST_CODE,
        "scripts/**",
        "apps/server/src/backfill-*.ts",
        "apps/server/src/canary.ts",
        "apps/web/src/lib/orbis.ts",
        "apps/raycast/src/orbis-client.ts",
      ],
      plugins: correctness.plugins,
      rules: { "effecttsgo/strict-effect-provide": "off" },
    },
    {
      // The Effect lint ledger: preset findings in code that predates the presets (PAL-1543).
      // PAL-1679 clears it; a new file gets each rule at error.
      files: [
        "apps/server/src/app-core.ts",
        "apps/server/src/app.ts",
        "apps/server/src/audio-service.ts",
        "apps/server/src/download-worker.ts",
        "apps/server/src/library.ts",
        "apps/server/src/media-store.ts",
        "apps/server/src/playlist-importer.ts",
        "apps/server/src/presence.ts",
        "apps/server/src/queue.ts",
      ],
      plugins: correctness.plugins,
      rules: {
        "effecttsgo/any-unknown-in-error-context": "off",
        "effecttsgo/lazy-effect": "off",
        "effecttsgo/strict-effect-provide": "off",
      },
    },
    {
      // Timeouts bound waiting, and concurrent work needs a bound (rat-stack principles 2 and 3).
      excludeFiles: TEST_CODE,
      files: ["apps/**", "packages/**", "scripts/**"],
      rules: {
        "orbis/bounded-concurrency": "error",
        "orbis/fetch-needs-timeout": "error",
      },
    },
    {
      // Oxlint publishes no types for a plugin's ESTree nodes, so a rule checks a literal's
      // value with typeof.
      files: ["lint-plugins/orbis/*.mjs"],
      rules: { "anti-slop/no-runtime-typeof": "off" },
    },
    {
      // Shared caches hold completed values (rat-stack principle 4).
      excludeFiles: TEST_CODE,
      files: RUNTIME_SOURCES,
      rules: {
        "orbis/no-module-level-mutable-state": "error",
        "orbis/no-shared-pending-cache": "error",
      },
    },
    {
      files: TEST_FILES,
      rules: {
        "t3code/no-test-in-loop": "error",
        "t3code/no-test-timeout-or-unreasoned-skip": "error",
        "t3code/no-wall-clock-in-tests": "error",
        // Tests may build one-off Effect functions; Effect.fn names spans for production code.
        "t3code/prefer-effect-fn": "off",
      },
    },
    {
      // Product copy that users read: the web app and the Raycast extension.
      excludeFiles: [...TEST_FILES, "apps/web/src/routeTree.gen.ts"],
      files: ["apps/web/src/**", "apps/raycast/src/**"],
      rules: { "t3code/no-em-dash-copy": "error" },
    },
    {
      // Presence leases and alarms run on the real clock inside the service, so this suite
      // waits out real lease windows and cannot swap in a fake clock.
      files: ["apps/server/src/presence-actions.test.ts"],
      rules: { "t3code/no-wall-clock-in-tests": "off" },
    },
  ],
  rules: {
    ...Object.fromEntries(
      ULTRACITE_TYPE_AWARE_DEBT.map((rule) => [rule, "off"])
    ),
    "orbis/directive-needs-reason": "error",
    "t3code/no-inline-schema-compile": "error",
    "t3code/prefer-effect-fn": "error",
    "t3code/require-suppression-reason": "error",
  },
});
