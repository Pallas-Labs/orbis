import { SIGN_IN_CODE } from "@orbis/contracts";

import { ShownCode } from "@/components/code-field";
import type { IssuedSignInCode } from "@/lib/sign-in";

const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

/** A Sign-in Code, large enough to read from across a table. */
export const SignInCode = ({
  issued,
  label,
}: {
  readonly issued: IssuedSignInCode;
  readonly label: string;
}) => (
  <div className="bg-muted flex flex-col items-center gap-2 rounded-2xl p-4">
    <ShownCode
      code={issued.code}
      copyLabel="Copy code"
      format={SIGN_IN_CODE}
      key={issued.code}
      label={label}
    />
    <p className="text-muted-foreground text-sm">
      Works once, until {timeFormat.format(new Date(issued.expiresAt))}.
    </p>
  </div>
);
