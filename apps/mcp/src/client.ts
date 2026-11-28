// The one door Orbis Code Mode has to Orbis: a typed `OrbisApi` client with the caller's device
// key. Every capability in the catalog calls one endpoint through it, so the service decides what
// the key may read or change, as it does for the web and Raycast clients.
import { OrbisApi } from "@orbis/contracts/http-api";
import { Config, Context, Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";

/** How long one call waits for the service to answer. */
const responseTimeout = "30 seconds";

const makeClient = (options: {
  readonly baseUrl: string;
  readonly token: Redacted.Redacted;
}) =>
  HttpApiClient.make(OrbisApi, {
    baseUrl: options.baseUrl.trim().replace(/\/+$/u, ""),
    transformClient: (client) =>
      client.pipe(
        HttpClient.mapRequest(
          HttpClientRequest.bearerToken(Redacted.value(options.token))
        ),
        HttpClient.timeout(responseTimeout)
      ),
  });

export type OrbisApiClient = Effect.Success<ReturnType<typeof makeClient>>;

export class OrbisClient extends Context.Service<OrbisClient, OrbisApiClient>()(
  "@orbis/mcp/OrbisClient"
) {
  /** A client for `baseUrl` with `token`, over whichever `HttpClient` the caller provides. */
  static readonly make = (options: {
    readonly baseUrl: string;
    readonly token: Redacted.Redacted;
  }) => Layer.effect(OrbisClient, makeClient(options));

  /** A client for `ORBIS_URL` with `ORBIS_DEVICE_TOKEN`; the token stays redacted in every log and error. */
  static readonly fromEnv = Layer.unwrap(
    Effect.gen(function* clientFromEnv() {
      const baseUrl = yield* Config.NonEmptyString("ORBIS_URL");
      const token = yield* Config.Redacted("ORBIS_DEVICE_TOKEN");
      return OrbisClient.make({ baseUrl, token });
    })
  );
}
