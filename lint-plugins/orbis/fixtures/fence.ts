// Each line that ends in `expect: <rule>`, and each line after `expect-next: <rule>`, must be
// reported with that rule, and no other line may be reported. scripts/fence.test.mjs lints this file with oxlintrc.json beside it.
import { Cache, Effect, Layer } from "effect";

declare const ids: readonly string[];
declare const load: (id: string) => Promise<string>;
declare const http: { readonly get: (url: string) => Effect.Effect<Response> };

// fetch-needs-timeout
export const unbounded = () => fetch("https://example.test"); // expect: orbis/fetch-needs-timeout
export const bounded = () =>
  fetch("https://example.test", { signal: AbortSignal.timeout(5000) });
export const piped = (HttpClient: typeof http) =>
  HttpClient.get("https://example.test").pipe(Effect.timeout("5 seconds"));
export const viaHttpClient = (HttpClient: typeof http) =>
  HttpClient.get("https://example.test"); // expect: orbis/fetch-needs-timeout

// bounded-concurrency
export const all = () => Promise.all(ids.map(load)); // expect: orbis/bounded-concurrency
export const fixed = () => Promise.all([load("a"), load("b")]);
export const forEach = Effect.forEach(ids, Effect.succeed, {
  concurrency: "unbounded", // expect: orbis/bounded-concurrency
});
export const numbered = Effect.forEach(ids, Effect.succeed, { concurrency: 4 });
// oxlint-disable-next-line orbis/bounded-concurrency -- two ids at most here.
export const reasoned = () => Promise.all(ids.map(load));

// no-module-level-mutable-state
let counter = 0; // expect: orbis/no-module-level-mutable-state
export const next = () => {
  let local = counter;
  local += 1;
  return local;
};

// no-shared-pending-cache
const pending = new Map<string, Promise<string>>(); // expect: orbis/no-shared-pending-cache
const started = Promise.resolve("value"); // expect: orbis/no-shared-pending-cache
export const cached = Effect.cached(Effect.succeed(1)); // expect: orbis/no-shared-pending-cache
export const cacheLayer = Layer.effect(
  "cache",
  Cache.make({ capacity: 1, lookup: Effect.succeed, timeToLive: "1 minute" }) // expect: orbis/no-shared-pending-cache
);
export const service = {
  perRequest: Effect.fn("perRequest")(function* perRequest() {
    return yield* Effect.cached(Effect.succeed(1));
  }),
};
export const read = () => [pending, started];

// no-flag-read-by-string
declare const client: {
  readonly getBooleanValue: (key: string, fallback: boolean) => boolean;
};
declare const flags: { readonly roundsV2: () => boolean };
export const byKey = () => client.getBooleanValue("rounds-v2", false); // expect: orbis/no-flag-read-by-string
export const byAccessor = () => flags.roundsV2();

// directive-needs-reason; the report lands on the directive itself.
// expect-next: orbis/directive-needs-reason
// oxlint-disable-next-line orbis/bounded-concurrency
export const noReason = () => Promise.all(ids.map(load));
