// Each line that ends in `expect: <rule>`, and each line after `expect-next: <rule>`, must be
// reported with that rule, and no other line may be reported. scripts/fence.test.mjs lints this file with oxlintrc.json beside it.
import * as stylex from "@stylexjs/stylex";
import { create } from "@stylexjs/stylex";
import * as sx from "@stylexjs/stylex";
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
declare const flags: { readonly fixtureOnlyFlag: () => boolean };
export const byKey = () => client.getBooleanValue("fixture-only-flag", false); // expect: orbis/no-flag-read-by-string
export const byAccessor = () => flags.fixtureOnlyFlag();

// directive-needs-reason; the report lands on the directive itself.
// expect-next: orbis/directive-needs-reason
// oxlint-disable-next-line orbis/bounded-concurrency
export const noReason = () => Promise.all(ids.map(load));

// stylex-tokens
declare const colors: { readonly ring: string; readonly primary: string };
declare const space: { readonly 4: string };
export const looks = stylex.create({
  box: {
    backgroundColor: "oklch(0.5 0.1 30)", // expect: orbis/stylex-tokens
    borderRadius: 12, // expect: orbis/stylex-tokens
    borderWidth: 2, // expect: orbis/stylex-tokens
    boxShadow: `0 0 0 3px color-mix(in oklab, ${colors.ring} 30%, transparent)`,
    color: { ":hover": "#fff", default: colors.primary }, // expect: orbis/stylex-tokens
    fontWeight: 500, // expect: orbis/stylex-tokens
    height: "100%",
    margin: "auto",
    maxHeight: "var(--available-height)",
    maxWidth: `calc(100% - 2rem)`, // expect: orbis/stylex-tokens
    opacity: 0.5,
    outlineColor: "transparent",
    outlineOffset: "var(--gap)", // expect: orbis/stylex-tokens
    padding: space[4],
    zIndex: -1,
  },
  dynamic: (inset: string) => ({
    gap: "0.5rem", // expect: orbis/stylex-tokens
    insetInlineStart: inset,
  }),
});
export const named = create({ row: { width: "12rem" } }); // expect: orbis/stylex-tokens
export const renamed = sx.create({ row: { width: "12rem" } }); // expect: orbis/stylex-tokens
