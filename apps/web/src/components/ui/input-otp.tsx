import * as stylex from "@stylexjs/stylex";
import { OTPInput, OTPInputContext } from "input-otp";
import { useContext } from "react";
import type { ComponentProps } from "react";

import type { Overrides } from "@/styles/overrides";
import {
  colors,
  layers,
  motion,
  radii,
  space,
  text,
} from "@/styles/tokens.stylex";

const blink = stylex.keyframes({
  "0%, 70%, 100%": { opacity: 1 },
  "20%, 50%": { opacity: 0 },
});

const styles = stylex.create({
  active: {
    borderColor: colors.ring,
    boxShadow: `0 0 0 3px ${colors.focusHalo}`,
    zIndex: layers.raised,
  },
  caret: {
    animationDuration: motion.blink,
    animationIterationCount: "infinite",
    animationName: blink,
    animationTimingFunction: "ease-out",
    backgroundColor: colors.foreground,
    height: space[4],
    width: space.px,
  },
  caretBox: {
    alignItems: "center",
    display: "flex",
    inset: 0,
    justifyContent: "center",
    pointerEvents: "none",
    position: "absolute",
  },
  container: {
    alignItems: "center",
    display: "flex",
    gap: space[2],
    opacity: { ":has(:disabled)": 0.5, default: null },
    width: "100%",
  },
  group: {
    alignItems: "center",
    borderRadius: radii.xl3,
    display: "flex",
  },
  input: { cursor: { ":disabled": "not-allowed", default: null } },
  slot: {
    alignItems: "center",
    backgroundColor: colors.fieldFill,
    borderBlockWidth: space.px,
    borderColor: colors.input,
    borderEndEndRadius: { ":last-child": radii.xl3, default: null },
    borderEndStartRadius: { ":first-child": radii.xl3, default: null },
    borderInlineEndWidth: space.px,
    borderInlineStartWidth: { ":first-child": space.px, default: 0 },
    borderStartEndRadius: { ":last-child": radii.xl3, default: null },
    borderStartStartRadius: { ":first-child": radii.xl3, default: null },
    borderStyle: "solid",
    display: "flex",
    justifyContent: "center",
    outlineStyle: "none",
    position: "relative",
    transitionDuration: motion.normal,
    transitionProperty: "all",
    transitionTimingFunction: motion.ease,
  },
});

/** How big a code box is: a field to type into, or a code shown to read from across a table. */
const slotSizes = stylex.create({
  field: {
    flexGrow: 1,
    fontSize: text.base,
    height: space[10],
    lineHeight: text.baseLeading,
    minWidth: 0,
  },
  shown: {
    flexShrink: 1,
    fontSize: text.xl2,
    height: space[11],
    lineHeight: text.xl2Leading,
    minWidth: 0,
    width: space[11],
  },
});

// input-otp's props are a union (slots drawn by `render`, or children), so the omit distributes.
type OTPInputProps<Props = ComponentProps<typeof OTPInput>> =
  Props extends unknown
    ? Omit<Props, "className" | "containerClassName" | "style">
    : never;

const InputOTP = (props: OTPInputProps) => (
  <OTPInput
    className={stylex.props(styles.input).className ?? ""}
    containerClassName={stylex.props(styles.container).className ?? ""}
    data-slot="input-otp"
    spellCheck={false}
    {...props}
  />
);

const InputOTPGroup = ({
  xstyle,
  ...props
}: Omit<ComponentProps<"div">, "className" | "style"> & {
  /** How the group shares its row with the others. */
  readonly xstyle?: Overrides<"flexGrow" | "minWidth">;
}) => (
  <div
    data-slot="input-otp-group"
    {...props}
    {...stylex.props(styles.group, xstyle)}
  />
);

const InputOTPSlot = ({
  index,
  size,
  ...props
}: Omit<ComponentProps<"div">, "className" | "style"> & {
  readonly index: number;
  readonly size: keyof typeof slotSizes;
}) => {
  const { char, hasFakeCaret, isActive } =
    useContext(OTPInputContext)?.slots[index] ?? {};
  return (
    <div
      data-active={isActive}
      data-slot="input-otp-slot"
      {...props}
      {...stylex.props(
        styles.slot,
        slotSizes[size],
        isActive === true && styles.active
      )}
    >
      {char}
      {hasFakeCaret === true ? (
        <div {...stylex.props(styles.caretBox)}>
          <div {...stylex.props(styles.caret)} />
        </div>
      ) : null}
    </div>
  );
};

export { InputOTP, InputOTPGroup, InputOTPSlot };
