import { fileURLToPath } from "node:url";

import stylex from "@stylexjs/unplugin/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import type { Plugin, PluginOption } from "vite";

const src = fileURLToPath(new URL("src/", import.meta.url));

// StyleX 0.19.1 appends its CSS to `styles.css`, which gives the file a new hash. It renames the
// file in the chunk code and in each chunk's `importedCss`, but not in `importedAssets`, where the
// root route's `styles.css?url` import is. Alchemy copies `importedAssets` into the deployed
// assets, so the old name fails the deploy. This plugin runs after StyleX and replaces each CSS
// name that no chunk references with the name the chunk code uses.
const stylexRenamedCss = (): Plugin => ({
  enforce: "post",
  generateBundle(_options, bundle) {
    const chunks = Object.values(bundle).filter(
      (file) => file.type === "chunk"
    );
    const code = chunks.map((chunk) => chunk.code).join("\n");
    for (const chunk of chunks) {
      const assets = chunk.viteMetadata?.importedAssets;
      if (assets === undefined) {
        continue;
      }
      for (const name of assets) {
        if (!name.endsWith(".css") || code.includes(name)) {
          continue;
        }
        const prefix = RegExp.escape(name.slice(0, -"XXXXXXXX.css".length));
        const renamed = new RegExp(`${prefix}[\\w-]{8}\\.css`, "u").exec(
          code
        )?.[0];
        if (renamed === undefined) {
          continue;
        }
        assets.delete(name);
        assets.add(renamed);
      }
    }
  },
  name: "orbis:stylex-renamed-css",
});

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
    stylexRenamedCss(),
    tanstackStart(),
    viteReact(),
  ],
  resolve: { tsconfigPaths: true },
});
