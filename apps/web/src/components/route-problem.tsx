import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { detach } from "@/lib/detach";
import { FAILURE_MESSAGES } from "@/lib/orbis";
import { layout } from "@/styles/layout";
import { widths } from "@/styles/tokens.stylex";
import { type } from "@/styles/type";

const styles = stylex.create({
  message: { maxWidth: widths.sm, textAlign: "center" },
});

/** A route whose data could not load, with a retry that re-runs its loaders. */
export const RouteProblem = ({ error }: ErrorComponentProps) => {
  const router = useRouter();
  // Invalidating re-runs beforeLoad and the loaders; resetting alone would not.
  const retry = async () => {
    await router.invalidate();
  };
  return (
    <main {...stylex.props(layout.centered, layout.stack4)}>
      <p {...stylex.props(type.error, styles.message, type.sm)} role="alert">
        {error instanceof Error ? error.message : FAILURE_MESSAGES.failed}
      </p>
      <Button onClick={detach(retry)} variant="outline">
        Try again
      </Button>
    </main>
  );
};
