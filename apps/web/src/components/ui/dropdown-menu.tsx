import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import * as stylex from "@stylexjs/stylex";

import {
  colors,
  filters,
  layers,
  radii,
  shadows,
  space,
  text,
  weights,
} from "@/styles/tokens.stylex";

const styles = stylex.create({
  // The frosted glass sits on a pseudo-element under the items, so it blurs the page, not them.
  content: {
    "::before": {
      backdropFilter: filters.glass,
      // A literal keyword: a variable that holds `inherit` inherits the variable, not the radius.
      borderRadius: "inherit",
      content: '""',
      inset: 0,
      pointerEvents: "none",
      position: "absolute",
      zIndex: -1,
    },
    backgroundColor: `color-mix(in oklab, ${colors.popover} 70%, transparent)`,
    borderRadius: radii.xl3,
    boxShadow: `0 0 0 1px ${colors.surfaceRing}, ${shadows.lg}`,
    color: colors.popoverForeground,
    maxHeight: "var(--available-height)",
    minWidth: space[48],
    outlineStyle: "none",
    overflowX: "hidden",
    overflowY: "auto",
    padding: space[1.5],
    position: "relative",
    transformOrigin: "var(--transform-origin)",
    width: "var(--anchor-width)",
    zIndex: layers.overlay,
  },
  contentClosed: { overflowY: "hidden" },
  // Inside the frosted menu a destructive item reads in the accent colour, as the shadcn
  // `default-translucent` menu drew it.
  destructive: { color: colors.accentForeground },
  disabled: { opacity: 0.5, pointerEvents: "none" },
  highlighted: {
    backgroundColor: `color-mix(in oklab, ${colors.foreground} 10%, transparent)`,
    color: colors.accentForeground,
  },
  item: {
    alignItems: "center",
    borderRadius: radii.xl2,
    cursor: "default",
    display: "flex",
    fontSize: text.sm,
    fontWeight: weights.medium,
    gap: space[2.5],
    lineHeight: text.smLeading,
    outlineStyle: "none",
    paddingBlock: space[2],
    paddingInline: space[3],
    position: "relative",
    userSelect: "none",
  },
  positioner: {
    isolation: "isolate",
    outlineStyle: "none",
    zIndex: layers.overlay,
  },
  separator: {
    backgroundColor: `color-mix(in oklab, ${colors.foreground} 5%, transparent)`,
    height: space.px,
    marginBlock: space[1.5],
    marginInline: `calc(-1 * ${space[1.5]})`,
  },
});

const DropdownMenu = (props: MenuPrimitive.Root.Props) => (
  <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />
);

const DropdownMenuTrigger = (props: MenuPrimitive.Trigger.Props) => (
  <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
);

const DropdownMenuContent = ({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  ...props
}: Omit<MenuPrimitive.Popup.Props, "className" | "style"> &
  Pick<
    MenuPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) => (
  <MenuPrimitive.Portal>
    <MenuPrimitive.Positioner
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      {...stylex.props(styles.positioner)}
    >
      <MenuPrimitive.Popup
        className={(state) =>
          stylex.props(styles.content, !state.open && styles.contentClosed)
            .className ?? ""
        }
        data-slot="dropdown-menu-content"
        {...props}
      />
    </MenuPrimitive.Positioner>
  </MenuPrimitive.Portal>
);

const DropdownMenuItem = ({
  variant = "default",
  ...props
}: Omit<MenuPrimitive.Item.Props, "className" | "style"> & {
  readonly variant?: "default" | "destructive";
}) => (
  <MenuPrimitive.Item
    className={(state) =>
      stylex.props(
        styles.item,
        variant === "destructive" && styles.destructive,
        state.highlighted && styles.highlighted,
        state.disabled && styles.disabled
      ).className ?? ""
    }
    data-slot="dropdown-menu-item"
    data-variant={variant}
    {...props}
  />
);

const DropdownMenuSeparator = (
  props: Omit<MenuPrimitive.Separator.Props, "className" | "style">
) => (
  <MenuPrimitive.Separator
    data-slot="dropdown-menu-separator"
    {...props}
    {...stylex.props(styles.separator)}
  />
);

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
};
