import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...ultracite.ignorePatterns,
    // `flags generate` writes these, and `flags check` compares their exact text.
    "flags.json",
    "flags.schema.json",
  ],
});
