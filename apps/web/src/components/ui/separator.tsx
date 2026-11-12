import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";
import * as stylex from "@stylexjs/stylex";

import { colors, space } from "@/styles/tokens.stylex";

const styles = stylex.create({
  base: { backgroundColor: colors.border, flexShrink: 0 },
  horizontal: { height: space.px, width: "100%" },
  vertical: { alignSelf: "stretch", width: space.px },
});

const Separator = ({
  orientation = "horizontal",
  ...props
}: Omit<SeparatorPrimitive.Props, "className" | "style">) => (
  <SeparatorPrimitive
    data-slot="separator"
    orientation={orientation}
    {...props}
    {...stylex.props(styles.base, styles[orientation])}
  />
);

export { Separator };
