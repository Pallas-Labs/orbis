import { fileURLToPath } from "node:url";

import stylex from "@stylexjs/unplugin/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import type { PluginOption } from "vite";

const src = fileURLToPath(new URL("src/", import.meta.url));

// Alchemy adds the Cloudflare plugin when it builds for deploy.
export default defineConfig({
  plugins: [
    // StyleX compiles `stylex.create` before React's plugin sees the code. It resolves
    // `@/styles/tokens.stylex` through the same alias as TypeScript, so a token gets one name
    // in every file, and it appends its CSS to the stylesheet the root route links.
    // SAFETY: @stylexjs/unplugin/vite declares its factory as returning `any`; it returns a Vite
    // plugin object, which `vite build` would refuse otherwise.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the factory's declared return type is `any`; see SAFETY above.
    stylex({
      aliases: { "@/*": [`${src}*`] },
      unstable_moduleResolution: { rootDir: src, type: "commonJS" },
      useCSSLayers: { before: ["reset"], prefix: "stylex" },
    }) as PluginOption,
    tanstackStart(),
    viteReact(),
  ],
  resolve: { tsconfigPaths: true },
});
