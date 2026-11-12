import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

import type { Overrides } from "@/styles/overrides";
import {
  colors,
  fonts,
  radii,
  shadows,
  space,
  text,
  weights,
  widths,
} from "@/styles/tokens.stylex";

const styles = stylex.create({
  action: {
    alignSelf: "start",
    gridColumnStart: 2,
    gridRowEnd: "span 2",
    gridRowStart: 1,
    justifySelf: "end",
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radii.xl4,
    boxShadow: `0 0 0 1px ${colors.surfaceRing}, ${shadows.md}`,
    color: colors.cardForeground,
    display: "flex",
    flexDirection: "column",
    fontSize: text.sm,
    gap: space[6],
    lineHeight: text.smLeading,
    overflow: "hidden",
    paddingBlock: space[6],
  },
  content: { paddingInline: space[6] },
  description: {
    color: colors.mutedForeground,
    fontSize: text.sm,
    lineHeight: text.smLeading,
  },
  header: {
    alignItems: "start",
    borderStartEndRadius: radii.xl4,
    borderStartStartRadius: radii.xl4,
    display: "grid",
    gap: space[1.5],
    gridAutoRows: "min-content",
    gridTemplateColumns: {
      ":has([data-slot=card-action])": "1fr auto",
      default: null,
    },
    gridTemplateRows: {
      ":has([data-slot=card-description])": "auto auto",
      default: null,
    },
    paddingInline: space[6],
  },
  title: {
    fontFamily: fonts.sans,
    fontSize: text.base,
    fontWeight: weights.medium,
    lineHeight: text.baseLeading,
  },
});

const tones = stylex.create({
  destructive: { color: colors.destructive },
});

/** Widths a card may take. */
export const cardSize = stylex.create({
  narrow: { maxWidth: widths.sm, width: "100%" },
});

type Div = Omit<ComponentProps<"div">, "className" | "style">;

/** A card's width; its look stays the card's. */
type CardSize = Overrides<"maxWidth" | "width">;
/** How a card part lays out what it holds. */
type CardLayout = Overrides<"display" | "flexDirection" | "gap">;

const Card = ({ xstyle, ...props }: Div & { readonly xstyle?: CardSize }) => (
  <div data-slot="card" {...props} {...stylex.props(styles.card, xstyle)} />
);

const CardHeader = (props: Div) => (
  <div data-slot="card-header" {...props} {...stylex.props(styles.header)} />
);

const CardTitle = (props: Div) => (
  <div data-slot="card-title" {...props} {...stylex.props(styles.title)} />
);

/** `tone="destructive"` draws the description as an error. */
const CardDescription = ({
  tone,
  ...props
}: Div & { readonly tone?: "destructive" }) => (
  <div
    data-slot="card-description"
    {...props}
    {...stylex.props(
      styles.description,
      tone === "destructive" && tones.destructive
    )}
  />
);

const CardAction = ({
  xstyle,
  ...props
}: Div & { readonly xstyle?: CardLayout }) => (
  <div
    data-slot="card-action"
    {...props}
    {...stylex.props(styles.action, xstyle)}
  />
);

const CardContent = ({
  xstyle,
  ...props
}: Div & { readonly xstyle?: CardLayout }) => (
  <div
    data-slot="card-content"
    {...props}
    {...stylex.props(styles.content, xstyle)}
  />
);

export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
};
