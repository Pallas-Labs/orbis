import * as stylex from "@stylexjs/stylex";
import {
  createFileRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useState } from "react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Problem } from "@/components/problem";
import { SignInCode } from "@/components/sign-in-code";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatDate, lastUsedText } from "@/lib/dates";
import { detach } from "@/lib/detach";
import { listDevices, requestSignInCode, revokeDevice } from "@/lib/devices";
import type { Device } from "@/lib/devices";
import { problemFor } from "@/lib/orbis";
import type { ApiResult } from "@/lib/orbis";
import type { IssuedSignInCode } from "@/lib/sign-in";
import { forgetKey } from "@/lib/stored-key";
import { useApiCall } from "@/lib/use-api-call";
import type { Session } from "@/routes/_app";
import { layout } from "@/styles/layout";
import { space } from "@/styles/tokens.stylex";
import { type } from "@/styles/type";

const styles = stylex.create({
  row: {
    alignItems: "center",
    display: "flex",
    gap: space[4],
    paddingBlock: space[4],
  },
});

const DeviceRow = ({
  device,
  session,
}: {
  readonly device: Device;
  readonly session: Session;
}) => {
  const router = useRouter();
  const navigate = useNavigate();
  const revoked = async () => {
    if (device.current) {
      forgetKey();
      await navigate({ to: "/sign-in" });
      return;
    }
    await router.invalidate();
  };
  return (
    <li {...stylex.props(styles.row, layout.divided)}>
      <div {...stylex.props(layout.stack1, layout.fill)}>
        <div {...stylex.props(layout.rowCenter2)}>
          <h2 {...stylex.props(type.truncate, type.medium)}>{device.label}</h2>
          {device.current ? (
            <Badge variant="secondary">This device</Badge>
          ) : null}
        </div>
        <p {...stylex.props(type.muted, type.sm)}>
          Added {formatDate(device.addedAt)} · {lastUsedText(device.lastUsedAt)}
        </p>
      </div>
      <ConfirmDialog
        action="Revoke"
        call={async () => await revokeDevice(session, device.id)}
        description={
          device.current
            ? "This is the device you are using. Revoking it signs you out here. To sign in again, use a Sign-in Code from another device."
            : "That device is signed out the next time it contacts Orbis."
        }
        label={`Revoke ${device.label}`}
        onDone={revoked}
        pendingAction="Revoking…"
        title={`Revoke ${device.label}?`}
        trigger="Revoke"
      />
    </li>
  );
};

const SignInAnotherDevice = ({ session }: { readonly session: Session }) => {
  const [code, setCode] = useState<IssuedSignInCode | null>(null);
  const { busy, problem, run } = useApiCall();
  const request = async () => {
    const issued = await run(async () => await requestSignInCode(session));
    if (issued !== null) {
      setCode(issued);
    }
  };
  return (
    <div {...stylex.props(layout.stack4)}>
      {code === null ? null : (
        <>
          <SignInCode issued={code} label="Your Sign-in Code" />
          <p {...stylex.props(type.muted, type.sm)}>
            On the new device, open Orbis, choose Sign in with a Sign-in Code,
            and type this code.
          </p>
        </>
      )}
      <Problem message={problem} />
      <Button
        xstyle={layout.selfStart}
        disabled={busy}
        onClick={detach(request)}
        variant={code === null ? "default" : "outline"}
      >
        {code === null ? "Sign in another device" : "Get a new code"}
      </Button>
    </div>
  );
};

const Devices = ({
  devices,
  session,
}: {
  readonly devices: ApiResult<{ readonly devices: readonly Device[] }>;
  readonly session: Session;
}) => (
  <main {...stylex.props(layout.main)}>
    <Card>
      <CardHeader>
        <CardTitle>
          <h1 {...stylex.props(type.xl2)}>Devices</h1>
        </CardTitle>
        <CardDescription>
          Each device signs in with its own key. Revoke a device you lost or no
          longer use.
        </CardDescription>
      </CardHeader>
      <CardContent xstyle={layout.stack4}>
        <SignInAnotherDevice session={session} />
        {devices.ok ? (
          <ul aria-label="Your devices">
            {devices.value.devices.map((device) => (
              <DeviceRow device={device} key={device.id} session={session} />
            ))}
          </ul>
        ) : (
          <Problem message={problemFor(devices)} />
        )}
      </CardContent>
    </Card>
  </main>
);

export const Route = createFileRoute("/_app/devices")({
  component: () => (
    <Devices
      devices={Route.useLoaderData()}
      session={Route.useRouteContext().session}
    />
  ),
  loader: async ({ context }) => await listDevices(context.session),
});
