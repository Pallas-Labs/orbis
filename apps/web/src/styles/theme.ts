import * as stylex from "@stylexjs/stylex";

import { colors, palette } from "./tokens.stylex";

/**
 * The dark colours. Nothing turns them on yet: the site draws light only, as it did before StyleX,
 * when only a `dark` class nothing set turned on the Tailwind dark theme.
 */
export const darkTheme = stylex.createTheme(colors, {
  accent: palette.mauve800,
  accentForeground: palette.snow,
  background: palette.mauve950,
  border: `color-mix(in oklab, ${palette.white} 10%, transparent)`,
  card: palette.mauve900,
  cardForeground: palette.snow,
  controlOff: `color-mix(in oklab, ${palette.white} 13.5%, transparent)`,
  destructive: palette.red400,
  destructiveFill: `color-mix(in oklab, ${palette.red400} 20%, transparent)`,
  destructiveFillHover: `color-mix(in oklab, ${palette.red400} 30%, transparent)`,
  fieldFill: `color-mix(in oklab, ${palette.white} 7.5%, transparent)`,
  focusHalo: `color-mix(in oklab, ${palette.mauve500} 30%, transparent)`,
  foreground: palette.snow,
  ghostHover: `color-mix(in oklab, ${palette.mauve800} 50%, transparent)`,
  input: `color-mix(in oklab, ${palette.white} 15%, transparent)`,
  invalidBorder: `color-mix(in oklab, ${palette.red400} 50%, transparent)`,
  invalidRing: `color-mix(in oklab, ${palette.red400} 40%, transparent)`,
  muted: palette.mauve800,
  mutedForeground: palette.mauve400,
  outlineFill: "transparent",
  outlineHover: `color-mix(in oklab, ${palette.white} 4.5%, transparent)`,
  popover: palette.mauve900,
  popoverForeground: palette.snow,
  primary: palette.orange700,
  ring: palette.mauve500,
  secondary: palette.zinc800,
  secondaryForeground: palette.snow,
  surfaceRing: `color-mix(in oklab, ${palette.snow} 10%, transparent)`,
  thumbOff: palette.snow,
  thumbOn: palette.orange50,
});

/**
 * The theme for each colour scheme; `<html>` applies the page's. A scheme of `null` draws the
 * default (light) values of `tokens.stylex.ts`.
 */
export const schemes = { dark: darkTheme, light: null } as const;
export type ColorScheme = keyof typeof schemes;
