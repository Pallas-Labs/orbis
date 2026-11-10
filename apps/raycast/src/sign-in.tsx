import { Action, ActionPanel, Form, popToRoot, Toast } from "@raycast/api";
import { useState } from "react";

import { settleToast, signIn, startToast } from "./orbis-client";

interface SignInValues {
  /** Vicinae submits a text field the user never touched as null. */
  readonly code: string | null;
}

export default function SignIn() {
  const [isLoading, setIsLoading] = useState(false);

  const submit = async ({ code }: SignInValues) => {
    setIsLoading(true);
    const toast = await startToast("Signing in…");
    const result = await signIn(code);
    setIsLoading(false);
    if (result.kind === "failed") {
      await settleToast(
        toast,
        {
          message: result.message,
          style: Toast.Style.Failure,
          title: "Couldn't sign in",
        },
        { endsAtRoot: false }
      );
      return;
    }
    await settleToast(
      toast,
      {
        message: "Save Current Tab and Save Clipboard are ready.",
        style: Toast.Style.Success,
        title: `Signed in as ${result.username}`,
      },
      { endsAtRoot: true }
    );
    await popToRoot();
  };

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm onSubmit={submit} title="Sign In" />
        </ActionPanel>
      }
      isLoading={isLoading}
    >
      <Form.Description text="In Orbis on a device you already use, open Settings and show a Sign-in Code. It works once and expires after 10 minutes." />
      <Form.TextField id="code" placeholder="ABCD-EFGH" title="Sign-in Code" />
    </Form>
  );
}
