# Style the web client with StyleX, not Tailwind

The web client styles its components with StyleX (PAL-2190). It replaces Tailwind 4, the shadcn generator, `cn`, `tailwind-merge` and `class-variance-authority`, which ADR 0015 chose with the `b3loz15fu` preset. The page looks the same: a screenshot of every page, in light and dark at phone and desktop width, matches the Tailwind build pixel for pixel, except where the port fixed a Tailwind bug.

**What holds the design.** `apps/web/src/styles/tokens.stylex.ts` defines every colour, length, type size, radius, shadow, layer and timing value with `defineVars`, and `theme.ts` gives the dark colours as a `createTheme`. A style names a token, so a misspelt or missing token is a type error. The lint rule `orbis/stylex-tokens` rejects a raw value that a token covers, and the StyleX ESLint rules reject a style StyleX cannot compile.

**The kit.** The components in `apps/web/src/components/ui` were shadcn's; they are now plain source that this repo owns, and `shadcn add` no longer applies. Base UI still provides behaviour. A component takes no `className`; where a caller may move or size it, it takes an `xstyle` prop typed to the properties it allows. StyleX styles an element, never its descendants, so an icon sizes itself through `Icon`.

**What stays CSS.** `src/styles/reset.css` is Tailwind 4.3.3's preflight (MIT), in a `reset` layer below StyleX's layers, and `src/fonts/inter.css` holds the font faces.

Rejected alternatives:

- **Keep Tailwind.** A class string is unchecked: a misspelt class, a class for a removed token, or two classes that set the same property all pass type-check and lint.
- **Depend on shadcn-cssinjs as a package.** Its components are a different shadcn style, so Orbis would override most of each one; copying the values Orbis already drew with was less code.
