import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

import {
  colors,
  layers,
  radii,
  space,
  text,
  weights,
} from "@/styles/tokens.stylex";

const styles = stylex.create({
  group: { alignItems: "stretch", display: "flex", width: "fit-content" },
  text: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderColor: colors.border,
    borderRadius: radii.xl4,
    borderStyle: "solid",
    borderWidth: space.px,
    display: "flex",
    fontSize: text.sm,
    fontWeight: weights.medium,
    gap: space[2],
    lineHeight: text.smLeading,
    paddingInline: space[2.5],
  },
});

/**
 * Joins the members of a group into one pill: only the first keeps its start corners and
 * border, only the last its end corners. StyleX cannot style a group's children from the group,
 * so each member carries this style.
 */
const grouping = stylex.create({
  item: {
    borderEndEndRadius: { ":last-child": radii.xl4, default: 0 },
    borderEndStartRadius: { ":not(:first-child)": 0, default: null },
    borderInlineStartWidth: { ":not(:first-child)": 0, default: null },
    borderStartEndRadius: { ":last-child": radii.xl4, default: 0 },
    borderStartStartRadius: { ":not(:first-child)": 0, default: null },
    position: { ":focus-visible": "relative", default: null },
    zIndex: { ":focus-visible": layers.raised, default: null },
  },
});
const groupItem = grouping.item;

const ButtonGroup = (
  props: Omit<ComponentProps<"div">, "className" | "style">
) => (
  <div
    data-orientation="horizontal"
    data-slot="button-group"
    role="group"
    {...props}
    {...stylex.props(styles.group)}
  />
);

/** A group member that is not a button, such as a time or a slider. */
const ButtonGroupText = ({
  render,
  ...props
}: Omit<useRender.ComponentProps<"div">, "className" | "style">) =>
  useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(stylex.props(styles.text, groupItem), props),
    render,
    state: { slot: "button-group-text" },
  });

export { ButtonGroup, ButtonGroupText, groupItem };
