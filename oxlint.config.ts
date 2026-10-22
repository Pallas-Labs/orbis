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
      },
    },
  ],
  rules: {
    "t3code/require-suppression-reason": "error",
  },
});
