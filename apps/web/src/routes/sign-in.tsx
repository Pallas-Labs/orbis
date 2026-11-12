import { SIGN_IN_CODE } from "@orbis/contracts";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, getRouteApi, redirect } from "@tanstack/react-router";
import { Schema } from "effect";

import { CodeField } from "@/components/code-field";
import { JoinFields, SignInForm, checkJoin } from "@/components/sign-in-form";
import {
  cardSize,
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
import { layout } from "@/styles/layout";

const SignInSearch = Schema.Struct({
  notice: Schema.optionalKey(Schema.Literal("expired")),
});

const signInRoute = getRouteApi("/sign-in");

const SignIn = () => {
  const { apiUrl } = signInRoute.useRouteContext();
  const { notice } = signInRoute.useSearch();
  return (
    <main {...stylex.props(layout.centered)}>
      <Card xstyle={cardSize.narrow}>
        <CardHeader>
          <CardTitle>
            <h1>Sign in to Orbis</h1>
          </CardTitle>
          {notice === "expired" ? (
            <CardDescription tone="destructive" role="alert">
              Your saved key no longer works. Sign in again.
            </CardDescription>
          ) : null}
        </CardHeader>
        <CardContent xstyle={layout.stack6}>
          <SignInForm
            call={async (form) =>
              await redeemSignInCode(apiUrl, formField(form, "code"))
            }
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
              <div {...stylex.props(layout.stack2)}>
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
            call={async (form) =>
              await joinGroup(
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
