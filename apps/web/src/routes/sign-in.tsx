import { SIGN_IN_CODE } from "@orbis/contracts";
import { createFileRoute, getRouteApi, redirect } from "@tanstack/react-router";
import { Schema } from "effect";

import { CodeField } from "@/components/code-field";
import { JoinFields, SignInForm, checkJoin } from "@/components/sign-in-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { formField } from "@/lib/form";
import { joinGroup, redeemSignInCode } from "@/lib/sign-in";
import { readKey } from "@/lib/stored-key";

const SignInSearch = Schema.Struct({
  notice: Schema.optionalKey(Schema.Literal("expired")),
});

const signInRoute = getRouteApi("/sign-in");

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
            check={checkJoin}
            description="Ask your Host for the Group Passcode."
            pendingLabel="Joining…"
            submitLabel="Join"
            title="Join with the Group Passcode"
          >
            {(submitWhenReady) => <JoinFields onComplete={submitWhenReady} />}
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
