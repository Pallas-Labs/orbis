import type { Icon as Glyph, IconProps } from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";

import type { Overrides } from "@/styles/overrides";
import { space } from "@/styles/tokens.stylex";

const styles = stylex.create({
  icon: { flexShrink: 0, pointerEvents: "none" },
});

const sizes = stylex.create({
  3: { height: space[3], width: space[3] },
  3.5: { height: space[3.5], width: space[3.5] },
  4: { height: space[4], width: space[4] },
});

/**
 * A Phosphor glyph at a token size. StyleX styles an element, never its descendants, so a
 * control cannot size the icons inside it the way Tailwind's `[&_svg]:size-4` did: the icon
 * sizes itself.
 */
const Icon = ({
  glyph: Glyph,
  size = 4,
  xstyle,
  ...props
}: Omit<IconProps, "className" | "size" | "style"> & {
  readonly glyph: Glyph;
  readonly size?: keyof typeof sizes;
  /** Where the icon sits and its colour; its size comes from `size`. */
  readonly xstyle?: Overrides<
    | "color"
    | "insetBlockStart"
    | "insetInlineEnd"
    | "position"
    | "translate"
    | "userSelect"
  >;
}) => (
  <Glyph
    aria-hidden
    {...props}
    {...stylex.props(styles.icon, sizes[size], xstyle)}
  />
);

export { Icon };
