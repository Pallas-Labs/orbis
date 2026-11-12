import * as stylex from "@stylexjs/stylex";
import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import type { ReactNode } from "react";

import { apiUrl } from "@/lib/api-url";
import { schemes } from "@/styles/theme";
import type { ColorScheme } from "@/styles/theme";
import { colors, fonts, space, widths } from "@/styles/tokens.stylex";
import { type } from "@/styles/type";

import interLatin from "../fonts/inter-latin.woff2?url";

import appCss from "../styles.css?url";

// The page's base: its colours and font, which every element inherits.
const documentStyles = stylex.create({
  body: { backgroundColor: colors.background, color: colors.foreground },
  html: { fontFamily: fonts.sans },
});

const notFoundStyles = stylex.create({
  main: {
    marginInline: "auto",
    maxWidth: widths.md,
    padding: space[6],
    paddingTop: space[16],
  },
});

// Only the Worker holds the API address, so the page asks it once per load.
const getApiUrl = createServerFn({ method: "GET" }).handler(() => apiUrl());
// oxlint-disable-next-line orbis/no-module-level-mutable-state -- holds the completed API address, the same for every page; it never holds the pending request.
let knownApiUrl: string | undefined;
const loadApiUrl = async (): Promise<string> => {
  knownApiUrl ??= await getApiUrl();
  return knownApiUrl;
};

// Every page draws light, as before StyleX: nothing let a Person choose dark, though Tailwind
// shipped its colours. The dark theme ships too, ready for a switch.
const scheme: ColorScheme = "light";

const RootDocument = ({ children }: { readonly children: ReactNode }) => (
  <html lang="en" {...stylex.props(schemes[scheme], documentStyles.html)}>
    <head>
      <HeadContent />
    </head>
    <body {...stylex.props(documentStyles.body)}>
      {children}
      <Scripts />
    </body>
  </html>
);

export const Route = createRootRoute({
  beforeLoad: async () => ({ apiUrl: await loadApiUrl() }),
  head: () => ({
    links: [
      // Every page draws Latin text, so its font loads with the stylesheet
      // instead of after it. Fonts load in CORS mode, even from this origin.
      {
        as: "font",
        crossOrigin: "anonymous",
        href: interLatin,
        rel: "preload",
        type: "font/woff2",
      },
      { href: appCss, rel: "stylesheet" },
      // In development StyleX serves its CSS from a virtual module; a build appends it to appCss.
      ...(import.meta.env.DEV
        ? [{ href: "/virtual:stylex.css", rel: "stylesheet" }]
        : []),
    ],
    meta: [
      { charSet: "utf-8" },
      { content: "width=device-width, initial-scale=1", name: "viewport" },
      { title: "Orbis" },
    ],
    // StyleX compiles a module's styles when Vite first serves it, after the page has fetched
    // its CSS. Its runtime fetches the CSS again each time a module compiles. Vite injects it
    // only into an index.html, which TanStack Start does not have.
    scripts: import.meta.env.DEV
      ? [{ src: "/@id/virtual:stylex:runtime", type: "module" }]
      : [],
  }),
  notFoundComponent: () => (
    <main {...stylex.props(notFoundStyles.main)}>
      <h1 {...stylex.props(type.medium)}>Page not found</h1>
    </main>
  ),
  shellComponent: RootDocument,
});
