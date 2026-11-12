import * as stylex from "@stylexjs/stylex";

import { motion } from "@/styles/tokens.stylex";

// How a dialog and a menu come and go: a 100 ms fade, and for a dialog a zoom from 95 %.
const fadeIn = stylex.keyframes({ from: { opacity: 0 } });
const fadeOut = stylex.keyframes({ to: { opacity: 0 } });
const zoomIn = stylex.keyframes({
  from: { opacity: 0, transform: "scale3d(0.95, 0.95, 0.95)" },
});
const zoomOut = stylex.keyframes({
  to: { opacity: 0, transform: "scale3d(0.95, 0.95, 0.95)" },
});

const motionStyles = stylex.create({
  fadeIn: { animationName: fadeIn },
  fadeOut: { animationName: fadeOut },
  timing: {
    animationDuration: motion.fast,
    animationTimingFunction: "ease",
  },
  zoomIn: { animationName: zoomIn },
  zoomOut: { animationName: zoomOut },
});

/** The motion for a part whose state says whether it is open. */
export const fade = (open: boolean) =>
  [
    motionStyles.timing,
    open ? motionStyles.fadeIn : motionStyles.fadeOut,
  ] as const;
export const zoom = (open: boolean) =>
  [
    motionStyles.timing,
    open ? motionStyles.zoomIn : motionStyles.zoomOut,
  ] as const;
