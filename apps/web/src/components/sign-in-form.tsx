import { GROUP_PASSCODE } from "@orbis/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useRef } from "react";
import type { SubmitEvent, ReactNode } from "react";

import { CodeField } from "@/components/code-field";
import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { detach } from "@/lib/detach";
import { formField } from "@/lib/form";
import type { ApiResult } from "@/lib/orbis";
import { storeKey } from "@/lib/stored-key";
import { useApiCall } from "@/lib/use-api-call";

/**
 * One way in: its fields, its own problem line, and one submit button. `check`
 * names what is missing before any call. `children` gets `submitWhenReady`,
 * which a code field calls when its last slot fills: it submits only when
 * `check` passes, so a passcode typed before the username raises no problem.
 */
export const SignInForm = ({
  call,
  check,
  children,
  description,
  pendingLabel,
  submitLabel,
  title,
}: {
  readonly call: (
    form: FormData
  ) => Promise<ApiResult<{ readonly key: string }>>;
  readonly check: (form: FormData) => string | null;
  readonly children: (submitWhenReady: () => void) => ReactNode;
  readonly description: string;
  readonly pendingLabel: string;
  readonly submitLabel: string;
  readonly title: string;
}) => {
  const navigate = useNavigate();
  const { busy, problem, refuse, run } = useApiCall();
  const formRef = useRef<HTMLFormElement>(null);
  const submitWhenReady = () => {
    const form = formRef.current;
    if (form !== null && !busy && check(new FormData(form)) === null) {
      form.requestSubmit();
    }
  };
  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const missing = check(form);
    if (missing !== null) {
      refuse(missing);
      return;
    }
    const signedIn = await run(() => call(form));
    if (signedIn !== null) {
      storeKey(signedIn.key);
      await navigate({ to: "/" });
    }
  };
  return (
    <form
      aria-label={title}
      className="flex flex-col gap-4"
      onSubmit={detach(submit)}
      ref={formRef}
    >
      <div className="flex flex-col gap-1">
        <h2 className="font-medium">{title}</h2>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      {children(submitWhenReady)}
      <Problem message={problem} />
      <Button disabled={busy} type="submit">
        {busy ? pendingLabel : submitLabel}
      </Button>
    </form>
  );
};

/** What joining still needs before it calls the API, or null. */
export const checkJoin = (form: FormData): string | null =>
  formField(form, "username") === "" || formField(form, "passcode") === ""
    ? "Choose a username and enter the Group Passcode."
    : null;

/**
 * Joining's fields: a username, and the Group Passcode, which a Join Link
 * fills in as `passcode`.
 */
export const JoinFields = ({
  onComplete,
  passcode,
}: {
  readonly onComplete: () => void;
  readonly passcode?: string | undefined;
}) => (
  <>
    <div className="flex flex-col gap-2">
      <Label htmlFor="username">Username</Label>
      <Input
        autoCapitalize="none"
        autoComplete="username"
        id="username"
        maxLength={40}
        name="username"
        spellCheck={false}
      />
    </div>
    <div className="flex flex-col gap-2">
      <Label htmlFor="passcode">Group Passcode</Label>
      <CodeField
        format={GROUP_PASSCODE}
        id="passcode"
        initialCode={passcode}
        label="Group Passcode"
        name="passcode"
        onComplete={onComplete}
      />
    </div>
  </>
);
