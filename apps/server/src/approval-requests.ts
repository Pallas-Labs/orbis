import { randomBytes, randomInt } from "node:crypto";

import type { StartApprovalRequestPayload } from "@orbis/contracts/http-api";
import { Deferred, Effect } from "effect";

import { AdminError, validLabel } from "./admin.js";
import { clientBucket } from "./attempt-limiter.js";
import { hashToken, matchesTokenHash } from "./identity.js";

type ApprovalPlatform = (typeof StartApprovalRequestPayload.Type)["platform"];

const LIFETIME_MS = 2 * 60 * 1000;
const CLIENT_LIVE_LIMIT = 3;
const GROUP_LIVE_LIMIT = 20;

interface ApprovalRequest {
  readonly code: string;
  readonly secretDigest: string;
  readonly label: string;
  readonly platform: ApprovalPlatform;
  readonly client: string;
  readonly requestedAt: number;
  readonly expiresAt: number;
  /** The approving Person; null while the request is pending. */
  approvedBy: string | null;
  /** Completes on approval, so an open wait answers at once. */
  readonly approved: Deferred.Deferred<void>;
}

const view = (request: ApprovalRequest) => ({
  code: request.code,
  label: request.label,
  platform: request.platform,
  requestedAt: new Date(request.requestedAt).toISOString(),
});

const newCode = () => String(randomInt(1_000_000)).padStart(6, "0");

/**
 * Approval Requests live only in memory, so a restart drops them. Expired
 * requests are pruned on every call. An approved request stays until its
 * device collects the key, and counts toward the live limits until then.
 */
export const makeApprovalRequests = (now: () => number = Date.now) => {
  const requests = new Map<string, ApprovalRequest>();
  const live = () => {
    const time = now();
    for (const [code, request] of requests) {
      if (request.expiresAt <= time) {
        requests.delete(code);
      }
    }
    return [...requests.values()];
  };
  const pending = (code: string) =>
    live().find(
      (request) =>
        request.approvedBy === null &&
        request.code === code.replaceAll(/\D/gu, "")
    );
  const bySecret = (secret: string) =>
    live().find((request) => matchesTokenHash(request.secretDigest, secret));
  return {
    /** Approves a live pending request once; null for any other code. */
    approve: (code: string, personId: string) => {
      const request = pending(code);
      if (!request) {
        return null;
      }
      request.approvedBy = personId;
      Deferred.doneUnsafe(request.approved, Effect.void);
      return view(request);
    },
    /**
     * Removes an approved request as it answers, so only one wait receives
     * the key. Null for an unknown or expired secret.
     */
    collect: (secret: string) => {
      const request = bySecret(secret);
      if (!request) {
        return null;
      }
      if (request.approvedBy === null) {
        return { status: "pending" as const };
      }
      requests.delete(request.code);
      return {
        label: request.label,
        personId: request.approvedBy,
        status: "approved" as const,
      };
    },
    /** A live pending request; null for any other code. */
    find: (code: string) => {
      const request = pending(code);
      return request ? view(request) : null;
    },
    /** Throws a 400 for a bad label and a 429 over a live limit. */
    start: (
      input: { readonly label: string; readonly platform: ApprovalPlatform },
      address: string
    ) => {
      const label = validLabel(input.label);
      const client = clientBucket(address);
      const current = live();
      if (
        current.length >= GROUP_LIVE_LIMIT ||
        current.filter((request) => request.client === client).length >=
          CLIENT_LIVE_LIMIT
      ) {
        throw new AdminError(
          429,
          "Too many devices are waiting to sign in. Try again in two minutes."
        );
      }
      let code = newCode();
      while (requests.has(code)) {
        code = newCode();
      }
      const secret = Buffer.from(randomBytes(32)).toString("base64url");
      const requestedAt = now();
      const expiresAt = requestedAt + LIFETIME_MS;
      requests.set(code, {
        approved: Deferred.makeUnsafe(),
        approvedBy: null,
        client,
        code,
        expiresAt,
        label,
        platform: input.platform,
        requestedAt,
        secretDigest: hashToken(secret),
      });
      return { code, expiresAt: new Date(expiresAt).toISOString(), secret };
    },
    /** What a wait holds open on; null for an unknown or expired secret. */
    watch: (secret: string) => {
      const request = bySecret(secret);
      return request
        ? {
            approved: request.approved,
            msLeft: Math.max(0, request.expiresAt - now()),
          }
        : null;
    },
  };
};
