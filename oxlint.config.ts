import { antipattern, correctness } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";

const TEST_FILES = ["**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}"];
// Test journeys and fixtures that drive the app from outside, like tests.
const TEST_CODE = [...TEST_FILES, "**/e2e/**", "**/evals/**"];
// Code that runs inside a server process, a Worker isolate or a browser tab.
const RUNTIME_SOURCES = ["apps/*/src/**", "packages/*/src/**"];

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
    "@stylexjs/eslint-plugin",
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
      // Tests, their helpers, fixture recorders and scripts read JSON, child-process output
      // and untyped .mjs modules as `any` and check the values they need with assertions;
      // typing each read would double the test code without catching more.
      files: [
        ...TEST_CODE,
        "**/*.mjs",
        "**/scripts/**",
        "apps/server/src/test-*.ts",
        "apps/server/src/apple-music-recordings.ts",
        "apps/server/src/record-apple-music-album.ts",
      ],
      rules: {
        "typescript/no-unsafe-argument": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-return": "off",
      },
    },
    {
      // typescript/strict-boolean-expressions -- no tsconfig covers an .mjs file, so tsgolint
      // reads most of its values as any and reports conditions that are already boolean.
      files: ["**/*.mjs"],
      rules: { "typescript/strict-boolean-expressions": "off" },
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
      // StyleX (PAL-2190): a style StyleX cannot compile, an unknown property or value, a
      // multi-value shorthand, or a raw value a token covers fails the check.
      files: ["apps/web/src/**/*.{ts,tsx}"],
      rules: {
        "@stylexjs/enforce-extension": "error",
        "@stylexjs/no-conflicting-props": "error",
        "@stylexjs/no-legacy-contextual-styles": "error",
        "@stylexjs/no-lookahead-selectors": "error",
        "@stylexjs/no-nonstandard-styles": "error",
        "@stylexjs/no-unused": "error",
        // @stylexjs/sort-keys -- off: it wants StyleX's property-priority order, which fights the
        // alphabetical eslint/sort-keys the repo keeps, and StyleX resolves a conflict by property
        // specificity, not by key order, so the order never changes the CSS.
        "@stylexjs/sort-keys": "off",
        "@stylexjs/valid-shorthands": "error",
        "@stylexjs/valid-styles": "error",
        "orbis/stylex-tokens": "error",
      },
    },
    {
      // eslint/sort-keys -- off in the design tokens: a scale reads smallest to largest and a
      // derived colour sits after the base colours it mixes, which an alphabetical order breaks.
      files: [
        "apps/web/src/styles/tokens.stylex.ts",
        "apps/web/src/styles/theme.ts",
      ],
      rules: { "eslint/sort-keys": "off" },
    },
    {
      // Product copy that users read: the web app and the Raycast extension.
      excludeFiles: [...TEST_FILES, "apps/web/src/routeTree.gen.ts"],
      files: ["apps/web/src/**", "apps/raycast/src/**"],
      rules: { "t3code/no-em-dash-copy": "error" },
    },
    {
      // typescript/promise-function-async -- a test double stubs a promise-returning interface
      // with `() => Promise.resolve(value)`. With this rule on, unicorn/no-useless-promise-resolve-reject
      // and eslint/require-await leave such a stub no form that passes.
      files: [...TEST_CODE, "apps/raycast/src/__tests__/**"],
      rules: { "typescript/promise-function-async": "off" },
    },
    {
      // Presence leases and alarms run on the real clock inside the service, so this suite
      // waits out real lease windows and cannot swap in a fake clock.
      files: ["apps/server/src/presence-actions.test.ts"],
      rules: { "t3code/no-wall-clock-in-tests": "off" },
    },
  ],
  rules: {
    "orbis/directive-needs-reason": "error",
    "orbis/no-flag-read-by-string": "error",
    "t3code/no-inline-schema-compile": "error",
    "t3code/prefer-effect-fn": "error",
    "t3code/require-suppression-reason": "error",
    // Off everywhere: an Effect generator ends a guard with `return yield* fail`, which
    // effecttsgo/missing-return-yield-star requires, and a React effect returns a cleanup on
    // some paths only. This rule reads both as a function that returns on some paths only.
    "typescript/consistent-return": "off",
    // node:test runs and awaits each test and suite it is handed.
    "typescript/no-floating-promises": [
      "error",
      {
        allowForKnownSafeCalls: [
          {
            from: "package",
            name: ["describe", "it", "suite", "test"],
            package: "node:test",
          },
        ],
      },
    ],
    // Off everywhere: anti-slop/no-unknown-parameters rejects `unknown` parameters, so an
    // error mapper that takes any failure names it with a type parameter used once.
    "typescript/no-unnecessary-type-parameters": "off",
    // TanStack Router's beforeLoad throws its redirect Response to change route.
    "typescript/only-throw-error": [
      "error",
      {
        allow: [
          {
            from: "package",
            name: "Redirect",
            package: "@tanstack/router-core",
          },
        ],
      },
    ],
    // `text?.trim() || fallback` sends an empty string to the fallback on purpose.
    "typescript/prefer-nullish-coalescing": [
      "error",
      { ignorePrimitives: { string: true } },
    ],
    // A condition on a string names the empty string. An object is always truthy, so
    // `if (object)` stays a plain null check.
    "typescript/strict-boolean-expressions": [
      "error",
      { allowNullableObject: true, allowString: false },
    ],
  },
});
