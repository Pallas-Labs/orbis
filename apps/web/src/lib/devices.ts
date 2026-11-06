import type { ApprovalRequestSchema } from "@orbis/contracts/http-api";

import { callOrbis } from "@/lib/orbis";
import type { Credentials } from "@/lib/orbis";

/** The signed-in Person's daily keys, one per device. */
export const listDevices = async (credentials: Credentials) =>
  await callOrbis(credentials, (client) => client.devices.list());

export type Device = Extract<
  Awaited<ReturnType<typeof listDevices>>,
  { ok: true }
>["value"]["devices"][number];

/** A one-time code that signs another device in as this Person (ADR 0020). */
export const requestSignInCode = async (credentials: Credentials) =>
  await callOrbis(credentials, (client) => client.devices.signInCode());

/** Revokes one of the Person's own keys. Revoking the current one signs this browser out. */
export const revokeDevice = async (credentials: Credentials, id: string) =>
  await callOrbis(credentials, (client) =>
    client.devices.revoke({ params: { id } })
  );

/** A signed-out device's Approval Request, as the Person who may approve it sees it (ADR 0022). */
export type ApprovalRequest = typeof ApprovalRequestSchema.Type;

/** The Approval Request that shows this Approval Code. 404 when none is waiting. */
export const findSignInRequest = async (
  credentials: Credentials,
  code: string
) =>
  await callOrbis(credentials, (client) =>
    client.devices.findSignInRequest({ payload: { code } })
  );

/** Signs the requesting device in as this Person. 404 when none is waiting. */
export const approveSignInRequest = async (
  credentials: Credentials,
  code: string
) =>
  await callOrbis(credentials, (client) =>
    client.devices.approveSignInRequest({ payload: { code } })
  );
