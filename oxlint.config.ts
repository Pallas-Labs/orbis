import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";

const TEST_FILES = ["**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}"];

export default defineConfig({
  extends: [core, antiSlop],
  ignorePatterns: [
    ...core.ignorePatterns,
    // shadcn generates these; `shadcn add` overwrites any hand edits.
    "apps/web/src/components/ui/**",
    "apps/web/src/components/ai-elements/**",
    // Vendored upstream plugin source; fix it upstream, not here.
    "lint-plugins/**",
  ],
  // Vendored from t3code; see lint-plugins/t3code/README.md.
  jsPlugins: ["./lint-plugins/t3code/index.ts"],
  overrides: [
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
    "t3code/no-inline-schema-compile": "error",
    "t3code/prefer-effect-fn": "error",
    "t3code/require-suppression-reason": "error",
  },
});
