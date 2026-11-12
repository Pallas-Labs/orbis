import * as stylex from "@stylexjs/stylex";

import { colors, text, weights } from "@/styles/tokens.stylex";

/**
 * The text styles most pages repeat. Each sets one concern, so a caller combines them:
 * `stylex.props(type.sm, type.muted)`. A size sets its line height too, as Tailwind's did.
 */
export const type = stylex.create({
  error: { color: colors.destructive },
  lg: { fontSize: text.lg, lineHeight: text.lgLeading },
  medium: { fontWeight: weights.medium },
  muted: { color: colors.mutedForeground },
  sm: { fontSize: text.sm, lineHeight: text.smLeading },
  tabular: { fontVariantNumeric: "tabular-nums" },
  /** A page's heading: `text-2xl font-medium`. */
  title: {
    fontSize: text.xl2,
    fontWeight: weights.medium,
    lineHeight: text.xl2Leading,
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  xl2: { fontSize: text.xl2, lineHeight: text.xl2Leading },
  xs: { fontSize: text.xs, lineHeight: text.xsLeading },
});
