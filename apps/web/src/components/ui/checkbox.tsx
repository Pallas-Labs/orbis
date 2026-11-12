import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { CheckIcon } from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";

import { Icon } from "@/components/ui/icon";
import { colors, motion, radii, space } from "@/styles/tokens.stylex";

const styles = stylex.create({
  checked: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
    color: colors.primaryForeground,
  },
  disabled: { cursor: "not-allowed", opacity: 0.5 },
  indicator: {
    color: "currentcolor",
    display: "grid",
    placeContent: "center",
    transitionProperty: "none",
  },
  root: {
    "::after": {
      content: '""',
      insetBlock: `calc(-1 * ${space[2]})`,
      insetInline: `calc(-1 * ${space[3]})`,
      position: "absolute",
    },
    alignItems: "center",
    backgroundColor: colors.controlOff,
    borderColor: { ":focus-visible": colors.ring, default: "transparent" },
    borderRadius: radii.checkbox,
    borderStyle: "solid",
    borderWidth: space.px,
    boxShadow: {
      ":focus-visible": `0 0 0 3px ${colors.focusHalo}`,
      default: null,
    },
    display: "flex",
    flexShrink: 0,
    height: space[4],
    justifyContent: "center",
    outlineStyle: "none",
    position: "relative",
    transitionDuration: motion.normal,
    transitionProperty: "box-shadow",
    transitionTimingFunction: motion.ease,
    width: space[4],
  },
});

/** Base UI hands each part its state, so a checked or disabled box styles itself. */
const Checkbox = (
  props: Omit<CheckboxPrimitive.Root.Props, "className" | "style">
) => (
  <CheckboxPrimitive.Root
    className={(state) =>
      stylex.props(
        styles.root,
        state.checked && styles.checked,
        state.disabled && styles.disabled
      ).className ?? ""
    }
    data-slot="checkbox"
    {...props}
  >
    <CheckboxPrimitive.Indicator
      data-slot="checkbox-indicator"
      {...stylex.props(styles.indicator)}
    >
      <Icon glyph={CheckIcon} size={3.5} />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
);

export { Checkbox };
