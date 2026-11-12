import { Input as InputPrimitive } from "@base-ui/react/input";
import * as stylex from "@stylexjs/stylex";

import { colors, motion, radii, space, text } from "@/styles/tokens.stylex";

/** A text field's look, shared with the select and the code boxes. */
const field = stylex.create({
  base: {
    backgroundColor: colors.fieldFill,
    borderColor: {
      ":focus-visible": colors.ring,
      ":is([aria-invalid=true])": colors.invalidBorder,
      default: "transparent",
    },
    borderStyle: "solid",
    borderWidth: space.px,
    boxShadow: {
      ":focus-visible": `0 0 0 3px ${colors.focusHalo}`,
      ":is([aria-invalid=true])": `0 0 0 3px ${colors.invalidRing}`,
      default: null,
    },
    cursor: { ":disabled": "not-allowed", default: null },
    minWidth: 0,
    outlineStyle: "none",
    pointerEvents: { ":disabled": "none", default: null },
    transitionDuration: motion.normal,
    transitionProperty: "color, box-shadow, background-color",
    transitionTimingFunction: motion.ease,
    width: "100%",
  },
});

const styles = stylex.create({
  input: {
    "::placeholder": { color: colors.mutedForeground },
    borderRadius: radii.xl3,
    fontSize: { "@media (min-width: 48rem)": text.sm, default: text.base },
    height: space[9],
    lineHeight: {
      "@media (min-width: 48rem)": text.smLeading,
      default: text.baseLeading,
    },
    opacity: { ":disabled": 0.5, default: null },
    paddingBlock: space[1],
    paddingInline: space[3],
  },
});

const Input = (props: Omit<InputPrimitive.Props, "className" | "style">) => (
  <InputPrimitive
    data-slot="input"
    {...props}
    {...stylex.props(field.base, styles.input)}
  />
);

export { field, Input };
