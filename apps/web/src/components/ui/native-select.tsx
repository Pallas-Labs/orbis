import { CaretDownIcon } from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

import { Icon } from "@/components/ui/icon";
import { field } from "@/components/ui/input";
import { colors, radii, space, text } from "@/styles/tokens.stylex";

const styles = stylex.create({
  caret: {
    color: colors.mutedForeground,
    insetBlockStart: "50%",
    insetInlineEnd: space[2.5],
    position: "absolute",
    translate: "0 -50%",
    userSelect: "none",
  },
  option: { backgroundColor: colors.canvas, color: colors.canvasText },
  select: {
    "::selection": {
      backgroundColor: colors.primary,
      color: colors.primaryForeground,
    },
    appearance: "none",
    borderRadius: radii.xl3,
    fontSize: text.sm,
    height: space[9],
    lineHeight: text.smLeading,
    paddingBlock: space[1],
    paddingInlineEnd: space[8],
    paddingInlineStart: space[3],
    userSelect: "none",
  },
  wrapper: {
    opacity: { ":has(select:disabled)": 0.5, default: null },
    position: "relative",
    width: "fit-content",
  },
});

const NativeSelect = (
  props: Omit<ComponentProps<"select">, "className" | "size" | "style">
) => (
  <div data-slot="native-select-wrapper" {...stylex.props(styles.wrapper)}>
    <select
      data-slot="native-select"
      {...props}
      {...stylex.props(field.base, styles.select)}
    />
    <Icon
      data-slot="native-select-icon"
      glyph={CaretDownIcon}
      xstyle={styles.caret}
    />
  </div>
);

const NativeSelectOption = (
  props: Omit<ComponentProps<"option">, "className" | "style">
) => (
  <option
    data-slot="native-select-option"
    {...props}
    {...stylex.props(styles.option)}
  />
);

export { NativeSelect, NativeSelectOption };
