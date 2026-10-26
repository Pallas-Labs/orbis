import { GROUP_PASSCODE, SIGN_IN_CODE } from "@orbis/contracts";
import {
  createFileRoute,
  getRouteApi,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { Schema } from "effect";
import { useRef } from "react";
import type { FormEvent, ReactNode } from "react";

import { CodeField } from "@/components/code-field";
import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { formField } from "@/lib/form";
import type { ApiResult } from "@/lib/orbis";
import { joinGroup, redeemSignInCode } from "@/lib/sign-in";
import { readKey, storeKey } from "@/lib/stored-key";
import { useApiCall } from "@/lib/use-api-call";

const SignInSearch = Schema.Struct({
  notice: Schema.optionalKey(Schema.Literal("expired")),
});

const signInRoute = getRouteApi("/sign-in");

/**
 * One way in: its fields, its own problem line, and one submit button. `check`
 * names what is missing before any call. `children` gets `submitWhenReady`,
 * which a code field calls when its last slot fills: it submits only when
 * `check` passes, so a passcode typed before the username raises no problem.
 */
const SignInForm = ({
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
  const submit = async (event: FormEvent<HTMLFormElement>) => {
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
      onSubmit={submit}
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

const SignIn = () => {
  const { apiUrl } = signInRoute.useRouteContext();
  const { notice } = signInRoute.useSearch();
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1>Sign in to Orbis</h1>
          </CardTitle>
          {notice === "expired" ? (
            <CardDescription className="text-destructive" role="alert">
              Your saved key no longer works. Sign in again.
            </CardDescription>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <SignInForm
            call={(form) => redeemSignInCode(apiUrl, formField(form, "code"))}
            check={(form) =>
              formField(form, "code").length === SIGN_IN_CODE.length
                ? null
                : "Enter the eight-character code from your other device."
            }
            description="On a device where you use Orbis, open Devices and choose Sign in another device."
            pendingLabel="Signing in…"
            submitLabel="Sign in"
            title="Sign in with a Sign-in Code"
          >
            {(submitWhenReady) => (
              <div className="flex flex-col gap-2">
                <Label htmlFor="sign-in-code">Sign-in Code</Label>
                <CodeField
                  format={SIGN_IN_CODE}
                  id="sign-in-code"
                  label="Sign-in Code"
                  name="code"
                  onComplete={submitWhenReady}
                />
              </div>
            )}
          </SignInForm>
          <Separator />
          <SignInForm
            call={(form) =>
              joinGroup(
                apiUrl,
                formField(form, "username"),
                formField(form, "passcode")
              )
            }
            check={(form) =>
              formField(form, "username") === "" ||
              formField(form, "passcode") === ""
                ? "Choose a username and enter the Group Passcode."
                : null
            }
            description="Ask your Host for the Group Passcode."
            pendingLabel="Joining…"
            submitLabel="Join"
            title="Join with the Group Passcode"
          >
            {(submitWhenReady) => (
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
                    label="Group Passcode"
                    name="passcode"
                    onComplete={submitWhenReady}
                  />
                </div>
              </>
            )}
          </SignInForm>
        </CardContent>
      </Card>
    </main>
  );
};

export const Route = createFileRoute("/sign-in")({
  beforeLoad: () => {
    if (readKey() !== null) {
      throw redirect({ to: "/" });
    }
  },
  component: SignIn,
  ssr: false,
  validateSearch: Schema.toStandardSchemaV1(SignInSearch),
});
