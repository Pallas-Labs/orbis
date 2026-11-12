import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

import { space, text, weights } from "@/styles/tokens.stylex";

const styles = stylex.create({
  label: {
    alignItems: "center",
    display: "flex",
    fontSize: text.sm,
    fontWeight: weights.medium,
    gap: space[2],
    lineHeight: text.leadingNone,
    userSelect: "none",
  },
});

const Label = (props: Omit<ComponentProps<"label">, "className" | "style">) => (
  <label data-slot="label" {...props} {...stylex.props(styles.label)} />
);

export { Label };
