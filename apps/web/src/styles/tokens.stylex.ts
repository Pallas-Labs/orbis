// Orbis web's design tokens. Every colour, length, radius, type size and shadow a style uses
// comes from here; `theme.ts` gives the dark values. The light values and the scales match the
// shadcn preset (`b3loz15fu`) and Tailwind 4 defaults the site was drawn with before StyleX.
import * as stylex from "@stylexjs/stylex";

/** Every raw colour. Styles never read these; they read `colors`, which the themes fill. */
export const palette = stylex.defineConsts({
  black: "rgb(0 0 0)",
  mauve100: "oklch(0.96 0.003 325.6)",
  mauve200: "oklch(0.922 0.005 325.62)",
  mauve400: "oklch(0.711 0.019 323.02)",
  mauve500: "oklch(0.542 0.034 322.5)",
  mauve800: "oklch(0.263 0.024 320.12)",
  mauve900: "oklch(0.212 0.019 322.12)",
  mauve950: "oklch(0.145 0.008 326)",
  orange50: "oklch(0.98 0.016 73.684)",
  orange600: "oklch(0.553 0.195 38.402)",
  orange700: "oklch(0.47 0.157 37.304)",
  red400: "oklch(0.704 0.191 22.216)",
  red600: "oklch(0.577 0.245 27.325)",
  snow: "oklch(0.985 0 0)",
  white: "oklch(1 0 0)",
  zinc100: "oklch(0.967 0.001 286.375)",
  zinc800: "oklch(0.274 0.006 286.033)",
  zinc900: "oklch(0.21 0.006 285.885)",
});

export const colors = stylex.defineVars({
  accent: palette.mauve100,
  accentForeground: palette.mauve900,
  background: palette.white,
  border: palette.mauve200,
  card: palette.white,
  cardForeground: palette.mauve950,
  destructive: palette.red600,
  foreground: palette.mauve950,
  input: palette.mauve200,
  muted: palette.mauve100,
  mutedForeground: palette.mauve500,
  popover: palette.white,
  popoverForeground: palette.mauve950,
  primary: palette.orange600,
  primaryForeground: palette.orange50,
  ring: palette.mauve400,
  /** The halo around a focused control. */
  focusHalo: `color-mix(in oklab, ${palette.mauve400} 30%, transparent)`,
  secondary: palette.zinc100,
  secondaryForeground: palette.zinc900,
  // Where dark changes more than the colours above. Each holds what one control draws.
  /** An outline button's fill, and under the pointer. */
  outlineFill: palette.white,
  outlineHover: palette.mauve100,
  /** A ghost button's fill under the pointer. */
  ghostHover: palette.mauve100,
  /** A destructive button's or badge's fill, and under the pointer. */
  destructiveFill: `color-mix(in oklab, ${palette.red600} 10%, transparent)`,
  destructiveFillHover: `color-mix(in oklab, ${palette.red600} 20%, transparent)`,
  /** A text field's, a select's and a code box's fill. */
  fieldFill: `color-mix(in oklab, ${palette.mauve200} 50%, transparent)`,
  /** An unchecked checkbox's fill and an off switch's track. */
  controlOff: `color-mix(in oklab, ${palette.mauve200} 90%, transparent)`,
  /** A switch's thumb, off and on. */
  thumbOff: palette.white,
  thumbOn: palette.white,
  /** The halo around an invalid field, and its border. */
  invalidRing: `color-mix(in oklab, ${palette.red600} 20%, transparent)`,
  invalidBorder: palette.red600,
  /** The hairline around a card, dialog or menu. */
  surfaceRing: `color-mix(in oklab, ${palette.mauve950} 5%, transparent)`,
  /** The system colours a native option draws with. */
  canvas: "Canvas",
  canvasText: "CanvasText",
  /** The scrim behind a dialog. */
  scrim: `color-mix(in oklab, ${palette.black} 30%, transparent)`,
});

const radius = "0.625rem";

export const radii = stylex.defineVars({
  /** A checkbox's corners. */
  checkbox: "5px",
  full: "calc(infinity * 1px)",
  lg: radius,
  md: `calc(${radius} * 0.8)`,
  sm: `calc(${radius} * 0.6)`,
  xl: `calc(${radius} * 1.4)`,
  xl2: `calc(${radius} * 1.8)`,
  xl3: `calc(${radius} * 2.2)`,
  xl4: `calc(${radius} * 2.6)`,
});

/** Tailwind's spacing scale: `space[4]` is 4 × 0.25rem. */
export const space = stylex.defineVars({
  0: "0px",
  0.5: "0.125rem",
  1: "0.25rem",
  1.5: "0.375rem",
  10: "2.5rem",
  11: "2.75rem",
  12: "3rem",
  16: "4rem",
  18: "4.5rem",
  2: "0.5rem",
  2.5: "0.625rem",
  3: "0.75rem",
  3.5: "0.875rem",
  32: "8rem",
  36: "9rem",
  4: "1rem",
  40: "10rem",
  48: "12rem",
  5: "1.25rem",
  6: "1.5rem",
  7: "1.75rem",
  8: "2rem",
  80: "20rem",
  9: "2.25rem",
  9.5: "2.375rem",
  px: "1px",
});

/** Widths a column of text or a dialog stops growing at. */
export const widths = stylex.defineVars({
  md: "28rem",
  sm: "24rem",
  xl: "36rem",
  xl3: "48rem",
  xs: "20rem",
});

export const fonts = stylex.defineVars({
  mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  sans: '"Inter Variable", sans-serif',
});

/** Type sizes, each with the line height Tailwind pairs with it. */
export const text = stylex.defineVars({
  base: "1rem",
  baseLeading: "1.5",
  leadingNone: "1",
  lg: "1.125rem",
  lgLeading: "calc(1.75 / 1.125)",
  sm: "0.875rem",
  smLeading: "calc(1.25 / 0.875)",
  widest: "0.1em",
  xl: "1.25rem",
  xl2: "1.5rem",
  xl2Leading: "calc(2 / 1.5)",
  xlLeading: "calc(1.75 / 1.25)",
  xs: "0.75rem",
  xsLeading: "calc(1 / 0.75)",
});

export const weights = stylex.defineVars({
  medium: "500",
  normal: "400",
});

export const shadows = stylex.defineVars({
  lg: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
  md: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
  sm: "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
  xl: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)",
});

export const motion = stylex.defineVars({
  /** One blink of a code box's caret. */
  blink: "1.25s",
  ease: "cubic-bezier(0.4, 0, 0.2, 1)",
  fast: "100ms",
  normal: "150ms",
});

/** Stacking order. */
export const layers = stylex.defineVars({
  overlay: "50",
  raised: "10",
});

/** Backdrop filters: a dialog's scrim and a menu's frosted glass. */
export const filters = stylex.defineVars({
  glass: "blur(40px) saturate(1.5)",
  scrim: "blur(8px)",
});
