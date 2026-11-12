import * as stylex from "@stylexjs/stylex";

import { colors, space, widths } from "@/styles/tokens.stylex";

/**
 * The layouts most pages repeat: a column or a row with a gap. A page keeps its own
 * `stylex.create` for anything else.
 */
export const layout = stylex.create({
  /** A page that centres its one child, such as a sign-in card. */
  centered: {
    alignItems: "center",
    display: "flex",
    justifyContent: "center",
    minHeight: "100svh",
    padding: space[6],
  },
  /** A row of a list with a rule under every row but the last, as Tailwind's `divide-y` drew it. */
  divided: {
    borderBottomColor: colors.border,
    borderBottomStyle: "solid",
    borderBottomWidth: { ":not(:last-child)": space.px, default: 0 },
  },
  /** A flex child that takes the free space and can shrink below its content. */
  fill: { flexBasis: "0%", flexGrow: 1, flexShrink: 1, minWidth: 0 },
  /** A link's keyboard focus ring colour, as Tailwind's base rule set it on every element. */
  focusOutline: {
    outlineColor: `color-mix(in oklab, ${colors.ring} 50%, transparent)`,
  },
  /** A page's main column. */
  main: {
    marginInline: "auto",
    maxWidth: widths.xl3,
    padding: space[6],
    width: "100%",
  },
  row2: { display: "flex", gap: space[2] },
  rowCenter2: { alignItems: "center", display: "flex", gap: space[2] },
  rowCenter3: { alignItems: "center", display: "flex", gap: space[3] },
  selfStart: { alignSelf: "start" },
  /** Text for screen readers only: Tailwind 4.3's `sr-only`. */
  srOnly: {
    borderWidth: 0,
    clipPath: "inset(50%)",
    height: space.px,
    margin: `calc(-1 * ${space.px})`,
    overflow: "hidden",
    padding: 0,
    position: "absolute",
    whiteSpace: "nowrap",
    width: space.px,
  },
  stack1: { display: "flex", flexDirection: "column", gap: space[1] },
  stack2: { display: "flex", flexDirection: "column", gap: space[2] },
  stack3: { display: "flex", flexDirection: "column", gap: space[3] },
  stack4: { display: "flex", flexDirection: "column", gap: space[4] },
  stack6: { display: "flex", flexDirection: "column", gap: space[6] },
});
