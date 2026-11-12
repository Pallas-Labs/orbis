import * as stylex from "@stylexjs/stylex";

import { type } from "@/styles/type";

/** Why the last action failed, announced to screen readers. Renders nothing without one. */
export const Problem = ({ message }: { readonly message: string | null }) =>
  message === null ? null : (
    <p {...stylex.props(type.error, type.sm)} role="alert">
      {message}
    </p>
  );
