import { SIGN_IN_CODE } from "@orbis/contracts";
import * as stylex from "@stylexjs/stylex";

import { ShownCode } from "@/components/code-field";
import type { IssuedSignInCode } from "@/lib/sign-in";
import { colors, radii, space } from "@/styles/tokens.stylex";
import { type } from "@/styles/type";

const styles = stylex.create({
  box: {
    alignItems: "center",
    backgroundColor: colors.muted,
    borderRadius: radii.xl2,
    display: "flex",
    flexDirection: "column",
    gap: space[2],
    padding: space[4],
  },
});

const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

/** A Sign-in Code, large enough to read from across a table. */
export const SignInCode = ({
  issued,
  label,
}: {
  readonly issued: IssuedSignInCode;
  readonly label: string;
}) => (
  <div {...stylex.props(styles.box)}>
    <ShownCode
      code={issued.code}
      copyLabel="Copy code"
      format={SIGN_IN_CODE}
      key={issued.code}
      label={label}
    />
    <p {...stylex.props(type.muted, type.sm)}>
      Works once, until {timeFormat.format(new Date(issued.expiresAt))}.
    </p>
  </div>
);
