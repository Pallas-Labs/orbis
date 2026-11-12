import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

import { buttonLook } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { fade, zoom } from "@/components/ui/surface";
import { layout } from "@/styles/layout";
import {
  colors,
  filters,
  fonts,
  layers,
  radii,
  shadows,
  space,
  text,
  weights,
  widths,
} from "@/styles/tokens.stylex";

/** The scrim and the centred panel, shared with the alert dialog. */
const modal = stylex.create({
  backdrop: {
    backdropFilter: filters.scrim,
    backgroundColor: colors.scrim,
    inset: 0,
    isolation: "isolate",
    position: "fixed",
    zIndex: layers.overlay,
  },
  popup: {
    backgroundColor: colors.popover,
    borderRadius: radii.xl4,
    boxShadow: `0 0 0 1px ${colors.surfaceRing}, ${shadows.xl}`,
    color: colors.popoverForeground,
    display: "grid",
    gap: space[6],
    insetBlockStart: "50%",
    insetInlineStart: "50%",
    outlineStyle: "none",
    padding: space[6],
    position: "fixed",
    translate: "-50% -50%",
    width: "100%",
    zIndex: layers.overlay,
  },
});

const styles = stylex.create({
  close: {
    backgroundColor: colors.secondary,
    insetBlockStart: space[4],
    insetInlineEnd: space[4],
    position: "absolute",
  },
  description: {
    color: colors.mutedForeground,
    fontSize: text.sm,
    lineHeight: text.smLeading,
  },
  footer: {
    display: "flex",
    flexDirection: {
      "@media (min-width: 40rem)": "row",
      default: "column-reverse",
    },
    gap: space[2],
    justifyContent: { "@media (min-width: 40rem)": "flex-end", default: null },
  },
  header: { display: "flex", flexDirection: "column", gap: space[1.5] },
  popup: {
    fontSize: text.sm,
    lineHeight: text.smLeading,
    maxWidth: {
      "@media (min-width: 40rem)": widths.md,
      default: `calc(100% - ${space[8]})`,
    },
  },
  title: {
    fontFamily: fonts.sans,
    fontSize: text.base,
    fontWeight: weights.medium,
    lineHeight: text.leadingNone,
  },
});

const Dialog = (props: DialogPrimitive.Root.Props) => (
  <DialogPrimitive.Root data-slot="dialog" {...props} />
);

const DialogTrigger = (props: DialogPrimitive.Trigger.Props) => (
  <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
);

const DialogContent = ({
  children,
  ...props
}: Omit<DialogPrimitive.Popup.Props, "className" | "style">) => (
  <DialogPrimitive.Portal data-slot="dialog-portal">
    <DialogPrimitive.Backdrop
      className={(state) =>
        stylex.props(modal.backdrop, fade(state.open)).className ?? ""
      }
      data-slot="dialog-overlay"
    />
    <DialogPrimitive.Popup
      className={(state) =>
        stylex.props(modal.popup, styles.popup, zoom(state.open)).className ??
        ""
      }
      data-slot="dialog-content"
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        data-slot="dialog-close"
        {...stylex.props(
          buttonLook({ size: "icon-sm", variant: "ghost" }),
          styles.close
        )}
      >
        <Icon glyph={XIcon} />
        <span {...stylex.props(layout.srOnly)}>Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Popup>
  </DialogPrimitive.Portal>
);

type Div = Omit<ComponentProps<"div">, "className" | "style">;

const DialogHeader = (props: Div) => (
  <div data-slot="dialog-header" {...props} {...stylex.props(styles.header)} />
);

const DialogFooter = (props: Div) => (
  <div data-slot="dialog-footer" {...props} {...stylex.props(styles.footer)} />
);

const DialogTitle = (
  props: Omit<DialogPrimitive.Title.Props, "className" | "style">
) => (
  <DialogPrimitive.Title
    data-slot="dialog-title"
    {...props}
    {...stylex.props(styles.title)}
  />
);

const DialogDescription = (
  props: Omit<DialogPrimitive.Description.Props, "className" | "style">
) => (
  <DialogPrimitive.Description
    data-slot="dialog-description"
    {...props}
    {...stylex.props(styles.description)}
  />
);

export {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  modal,
  styles as dialogParts,
};
