import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

import {
  colors,
  motion,
  radii,
  space,
  text,
  weights,
} from "@/styles/tokens.stylex";

const styles = stylex.create({
  base: {
    alignItems: "center",
    borderColor: "transparent",
    borderRadius: radii.xl3,
    borderStyle: "solid",
    borderWidth: space.px,
    display: "inline-flex",
    flexShrink: 0,
    fontSize: text.xs,
    fontWeight: weights.medium,
    gap: space[1],
    height: space[5],
    justifyContent: "center",
    lineHeight: text.xsLeading,
    overflow: "hidden",
    paddingBlock: space[0.5],
    paddingInline: space[2],
    transitionDuration: motion.normal,
    transitionProperty: "all",
    transitionTimingFunction: motion.ease,
    whiteSpace: "nowrap",
    width: "fit-content",
  },
});

const variants = stylex.create({
  destructive: {
    backgroundColor: colors.destructiveFill,
    color: colors.destructive,
  },
  outline: { borderColor: colors.border, color: colors.foreground },
  secondary: {
    backgroundColor: colors.secondary,
    color: colors.secondaryForeground,
  },
});

const Badge = ({
  variant,
  ...props
}: Omit<ComponentProps<"span">, "className" | "style"> & {
  readonly variant: keyof typeof variants;
}) => (
  <span
    data-slot="badge"
    {...props}
    {...stylex.props(styles.base, variants[variant])}
  />
);

export { Badge };
