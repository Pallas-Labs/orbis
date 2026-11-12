import { Button as ButtonPrimitive } from "@base-ui/react/button";
import * as stylex from "@stylexjs/stylex";

import { groupItem } from "@/components/ui/button-group";
import type { Overrides } from "@/styles/overrides";
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
    backgroundClip: "padding-box",
    borderColor: { ":focus-visible": colors.ring, default: "transparent" },
    borderRadius: radii.xl4,
    borderStyle: "solid",
    borderWidth: space.px,
    boxShadow: {
      ":focus-visible": `0 0 0 3px ${colors.focusHalo}`,
      default: null,
    },
    display: "inline-flex",
    flexShrink: 0,
    fontSize: text.sm,
    fontWeight: weights.medium,
    justifyContent: "center",
    lineHeight: text.smLeading,
    opacity: { ":disabled": 0.5, default: null },
    outlineStyle: "none",
    pointerEvents: { ":disabled": "none", default: null },
    transitionDuration: motion.normal,
    transitionProperty: "all",
    transitionTimingFunction: motion.ease,
    translate: { ":active:not([aria-haspopup])": "0 1px", default: null },
    userSelect: "none",
    whiteSpace: "nowrap",
  },
});

const variants = stylex.create({
  default: {
    backgroundColor: {
      ":hover": {
        "@media (hover: hover)": `color-mix(in oklab, ${colors.primary} 80%, transparent)`,
        default: null,
      },
      default: colors.primary,
    },
    color: colors.primaryForeground,
  },
  destructive: {
    backgroundColor: {
      ":hover": {
        "@media (hover: hover)": colors.destructiveFillHover,
        default: null,
      },
      default: colors.destructiveFill,
    },
    borderColor: {
      ":focus-visible": `color-mix(in oklab, ${colors.destructive} 40%, transparent)`,
      default: "transparent",
    },
    boxShadow: {
      ":focus-visible": `0 0 0 3px ${colors.invalidRing}`,
      default: null,
    },
    color: colors.destructive,
  },
  ghost: {
    backgroundColor: {
      ":hover": { "@media (hover: hover)": colors.ghostHover, default: null },
      ":is([aria-expanded=true])": colors.muted,
      default: null,
    },
    color: {
      ":hover": { "@media (hover: hover)": colors.foreground, default: null },
      ":is([aria-expanded=true])": colors.foreground,
      default: null,
    },
  },
  outline: {
    backgroundColor: {
      ":hover": { "@media (hover: hover)": colors.outlineHover, default: null },
      ":is([aria-expanded=true])": colors.muted,
      default: colors.outlineFill,
    },
    borderColor: { ":focus-visible": colors.ring, default: colors.border },
    color: {
      ":hover": { "@media (hover: hover)": colors.foreground, default: null },
      ":is([aria-expanded=true])": colors.foreground,
      default: null,
    },
  },
  secondary: {
    backgroundColor: {
      ":hover": {
        "@media (hover: hover)": `color-mix(in oklch, ${colors.secondary}, ${colors.foreground} 5%)`,
        default: null,
      },
      default: colors.secondary,
    },
    color: colors.secondaryForeground,
  },
});

const sizes = stylex.create({
  default: {
    gap: space[1.5],
    height: space[9],
    paddingInline: space[3],
    paddingInlineStart: {
      ":has([data-icon=inline-start])": space[2.5],
      default: null,
    },
  },
  icon: { height: space[9], width: space[9] },
  "icon-sm": { height: space[8], width: space[8] },
  sm: {
    gap: space[1],
    height: space[8],
    paddingInline: space[3],
    paddingInlineStart: {
      ":has([data-icon=inline-start])": space[2],
      default: null,
    },
  },
});

type ButtonVariant = keyof typeof variants;
type ButtonSize = keyof typeof sizes;

interface ButtonLook {
  readonly variant?: ButtonVariant | undefined;
  readonly size?: ButtonSize | undefined;
}

/** A button's styles, for a link drawn as a button: `<Link {...stylex.props(buttonLook())}>`. */
const buttonLook = ({
  size = "default",
  variant = "default",
}: ButtonLook = {}) => [styles.base, variants[variant], sizes[size]] as const;

/** What a caller may change about a button: where it sits, not how it looks. */
type ButtonPlacement = Overrides<
  "alignSelf" | "insetBlockStart" | "insetInlineEnd" | "position"
>;

const Button = ({
  grouped = false,
  size,
  variant,
  xstyle,
  ...props
}: Omit<ButtonPrimitive.Props, "className" | "style"> &
  ButtonLook & {
    /** The button is a member of a `ButtonGroup`, joined to its neighbours. */
    readonly grouped?: boolean;
    readonly xstyle?: ButtonPlacement;
  }) => (
  <ButtonPrimitive
    data-slot="button"
    {...props}
    {...stylex.props(
      buttonLook({ size, variant }),
      grouped && groupItem,
      xstyle
    )}
  />
);

export { Button, buttonLook };
export type { ButtonLook };
