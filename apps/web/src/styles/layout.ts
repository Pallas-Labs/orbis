import * as stylex from "@stylexjs/stylex";

import { space } from "@/styles/tokens.stylex";

/**
 * The layouts most pages repeat: a column or a row with a gap. A page keeps its own
 * `stylex.create` for anything else.
 */
export const layout = stylex.create({
  row2: { display: "flex", gap: space[2] },
  selfStart: { alignSelf: "start" },
  stack1: { display: "flex", flexDirection: "column", gap: space[1] },
  stack2: { display: "flex", flexDirection: "column", gap: space[2] },
  stack3: { display: "flex", flexDirection: "column", gap: space[3] },
  stack4: { display: "flex", flexDirection: "column", gap: space[4] },
  stack6: { display: "flex", flexDirection: "column", gap: space[6] },
});
