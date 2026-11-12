import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import * as stylex from "@stylexjs/stylex";

import { colors, motion, radii, shadows, space } from "@/styles/tokens.stylex";

const styles = stylex.create({
  checked: { backgroundColor: colors.primary, borderColor: colors.primary },
  disabled: { cursor: "not-allowed", opacity: 0.5 },
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
    borderRadius: radii.full,
    borderStyle: "solid",
    borderWidth: space[0.5],
    boxShadow: {
      ":focus-visible": `0 0 0 3px ${colors.focusHalo}`,
      default: null,
    },
    display: "inline-flex",
    flexShrink: 0,
    height: space[5],
    outlineStyle: "none",
    position: "relative",
    transitionDuration: motion.normal,
    transitionProperty: "all",
    transitionTimingFunction: motion.ease,
    width: space[11],
  },
  rootSmall: { height: space[4], width: space[7] },
  thumb: {
    backgroundClip: "padding-box",
    backgroundColor: colors.thumbOff,
    borderRadius: radii.full,
    boxShadow: shadows.sm,
    display: "block",
    height: space[4],
    pointerEvents: "none",
    transitionDuration: motion.normal,
    transitionProperty: "transform, translate, scale, rotate",
    transitionTimingFunction: motion.ease,
    width: space[6],
  },
  thumbChecked: {
    backgroundColor: colors.thumbOn,
    translate: `calc(100% - ${space[2]}) 0`,
  },
  thumbSmall: { height: space[3], width: space[4] },
});

const Switch = ({
  size = "default",
  ...props
}: Omit<SwitchPrimitive.Root.Props, "className" | "style"> & {
  readonly size?: "default" | "sm";
}) => (
  <SwitchPrimitive.Root
    className={(state) =>
      stylex.props(
        styles.root,
        size === "sm" && styles.rootSmall,
        state.checked && styles.checked,
        state.disabled && styles.disabled
      ).className ?? ""
    }
    data-size={size}
    data-slot="switch"
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={(state) =>
        stylex.props(
          styles.thumb,
          size === "sm" && styles.thumbSmall,
          state.checked && styles.thumbChecked
        ).className ?? ""
      }
      data-slot="switch-thumb"
    />
  </SwitchPrimitive.Root>
);

export { Switch };
