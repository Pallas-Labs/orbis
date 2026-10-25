import { Effect } from "effect";

/** What the Host gives the Group to read the Apple Music catalog: one MusicKit key (ADR 0021). */
export interface AppleMusicCredentials {
  readonly keyId: string;
  /** The `.p8` file's contents, PEM armor included. */
  readonly privateKey: string;
  readonly teamId: string;
}

/** Apple accepts a developer token for up to six months; an hour keeps a leaked one short-lived. */
const TOKEN_SECONDS = 3600;
/** A token this close to expiry is replaced, so a slow request never arrives with a stale one. */
const REFRESH_SECONDS = 300;

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

const encodeJson = (value: Readonly<Record<string, string | number>>): string =>
  base64Url(new TextEncoder().encode(JSON.stringify(value)));

const pkcs8 = (pem: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(
    atob(pem.replaceAll(/-----[^-]+-----|\s/gu, "")),
    (character) => character.codePointAt(0) ?? 0
  );

/**
 * Signs an ES256 developer token with WebCrypto, which Bun and the Group's runtime both carry, so
 * no JWT library rides in the Worker bundle. ECDSA's WebCrypto signature is already the raw
 * `r || s` pair a JWS expects.
 */
const signToken = async (
  credentials: AppleMusicCredentials,
  issuedAt: number
): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8(credentials.privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const unsigned = `${encodeJson({ alg: "ES256", kid: credentials.keyId })}.${encodeJson(
    { exp: issuedAt + TOKEN_SECONDS, iat: issuedAt, iss: credentials.teamId }
  )}`;
  const signature = await crypto.subtle.sign(
    { hash: "SHA-256", name: "ECDSA" },
    key,
    new TextEncoder().encode(unsigned)
  );
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
};

/**
 * A developer token, signed once and reused until it nears expiry. A key Apple's format rejects
 * fails the read that asked, not the Group's startup.
 */
export const appleMusicTokens = (
  credentials: AppleMusicCredentials,
  now: () => number = Date.now
) => {
  let cached: { readonly expiresAt: number; readonly token: string } | null =
    null;
  return Effect.fn("AppleMusic.token")(function* currentToken() {
    const seconds = Math.floor(now() / 1000);
    if (cached && cached.expiresAt - seconds > REFRESH_SECONDS) {
      return cached.token;
    }
    const token = yield* Effect.tryPromise(() =>
      signToken(credentials, seconds)
    );
    cached = { expiresAt: seconds + TOKEN_SECONDS, token };
    return token;
  });
};
