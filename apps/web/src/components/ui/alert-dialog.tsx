import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import type { ButtonLook } from "@/components/ui/button";
import { dialogParts, modal } from "@/components/ui/dialog";
import { fade, zoom } from "@/components/ui/surface";
import {
  colors,
  fonts,
  space,
  text,
  weights,
  widths,
} from "@/styles/tokens.stylex";

const styles = stylex.create({
  description: {
    color: colors.mutedForeground,
    fontSize: text.sm,
    lineHeight: text.smLeading,
    textWrap: { "@media (min-width: 48rem)": "pretty", default: "balance" },
  },
  header: {
    display: "grid",
    gap: space[1.5],
    gridTemplateRows: "auto 1fr",
    placeItems: { "@media (min-width: 40rem)": "start", default: "center" },
    textAlign: { "@media (min-width: 40rem)": "left", default: "center" },
  },
  popup: {
    maxWidth: { "@media (min-width: 40rem)": widths.md, default: widths.xs },
  },
  title: {
    fontFamily: fonts.sans,
    fontSize: text.lg,
    fontWeight: weights.medium,
    lineHeight: text.lgLeading,
  },
});

const AlertDialog = (props: AlertDialogPrimitive.Root.Props) => (
  <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />
);

const AlertDialogTrigger = (props: AlertDialogPrimitive.Trigger.Props) => (
  <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
);

const AlertDialogContent = (
  props: Omit<AlertDialogPrimitive.Popup.Props, "className" | "style">
) => (
  <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal">
    <AlertDialogPrimitive.Backdrop
      className={(state) =>
        stylex.props(modal.backdrop, fade(state.open)).className ?? ""
      }
      data-slot="alert-dialog-overlay"
    />
    <AlertDialogPrimitive.Popup
      className={(state) =>
        stylex.props(modal.popup, styles.popup, zoom(state.open)).className ??
        ""
      }
      data-slot="alert-dialog-content"
      {...props}
    />
  </AlertDialogPrimitive.Portal>
);

type Div = Omit<ComponentProps<"div">, "className" | "style">;

const AlertDialogHeader = (props: Div) => (
  <div
    data-slot="alert-dialog-header"
    {...props}
    {...stylex.props(styles.header)}
  />
);

const AlertDialogFooter = (props: Div) => (
  <div
    data-slot="alert-dialog-footer"
    {...props}
    {...stylex.props(dialogParts.footer)}
  />
);

const AlertDialogTitle = (
  props: Omit<AlertDialogPrimitive.Title.Props, "className" | "style">
) => (
  <AlertDialogPrimitive.Title
    data-slot="alert-dialog-title"
    {...props}
    {...stylex.props(styles.title)}
  />
);

const AlertDialogDescription = (
  props: Omit<AlertDialogPrimitive.Description.Props, "className" | "style">
) => (
  <AlertDialogPrimitive.Description
    data-slot="alert-dialog-description"
    {...props}
    {...stylex.props(styles.description)}
  />
);

const AlertDialogAction = (props: ComponentProps<typeof Button>) => (
  <Button data-slot="alert-dialog-action" {...props} />
);

const AlertDialogCancel = ({
  size,
  variant = "outline",
  ...props
}: Omit<AlertDialogPrimitive.Close.Props, "className" | "render" | "style"> &
  ButtonLook) => (
  <AlertDialogPrimitive.Close
    data-slot="alert-dialog-cancel"
    render={<Button size={size} variant={variant} />}
    {...props}
  />
);

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
};
