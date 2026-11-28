// The Orbis Code Mode engine (PAL-3053): runs a JavaScript program on psychoscript's confined VM,
// whose only reach outside is the catalog's namespaces. Programs have no file system, network,
// process, timers, `eval` or `Function`; each run is bounded in time and output.
import { Clock, Effect, Schema } from "effect";
import { Host, Runtime } from "psychoscript/effect";

import { catalog, namespaces } from "./catalog.js";
import type { Capability } from "./catalog.js";
import { suggest } from "./suggest.js";

export const defaultTimeoutMs = 15_000;
export const defaultMaxOutputBytes = 64_000;
const timeoutRange = { max: 60_000, min: 100 } as const;
const outputRange = { max: 1_000_000, min: 1024 } as const;
/** The most tool calls a result lists; the rest are counted in `toolCallsDropped`. */
const toolCallsKept = 100;

export interface Limits {
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
}

export interface RunOptions {
  readonly maxOutputBytes?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface ToolCall {
  readonly ms: number;
  readonly ok: boolean;
  readonly path: string;
}

export interface CodemodeError {
  readonly kind: string;
  readonly message: string;
  readonly location?: { readonly line: number; readonly column: number };
  readonly suggestions?: readonly string[];
}

/** What a run returns: its value or its error, with its logs, warnings, tool calls and limits. */
export type CodemodeResult = {
  readonly limits: Limits;
  readonly logs: readonly string[];
  readonly toolCalls: readonly ToolCall[];
  readonly toolCallsDropped: number;
  readonly truncated: boolean;
  readonly warnings: readonly CodemodeError[];
} & (
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: CodemodeError }
);

const clamp = (
  value: number | undefined,
  fallback: number,
  range: { readonly min: number; readonly max: number }
) =>
  value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.min(range.max, Math.max(range.min, Math.floor(value)));

/** The limits a run takes: the defaults, or the asked values held within the caps. */
export const limitsOf = (options: RunOptions = {}): Limits => ({
  maxOutputBytes: clamp(
    options.maxOutputBytes,
    defaultMaxOutputBytes,
    outputRange
  ),
  timeoutMs: clamp(options.timeoutMs, defaultTimeoutMs, timeoutRange),
});

/** A program's argument crosses as a copy; anything that is not JSON is refused. */
const decodeInput = Schema.decodeUnknownEffect(Schema.UndefinedOr(Schema.Json));

const byNamespace = (namespace: string): readonly Capability[] =>
  catalog.filter((each) => each.namespace === namespace);

/**
 * Runs `code` once. The program reaches each namespace (`sets`, `curate`, …) as a lazy object, so
 * `Object.keys(sets)` lists its functions, and a call to a name that is not there fails with the
 * nearest names.
 */
export const execute = Effect.fnUntraced(function* execute(
  code: string,
  options?: RunOptions
) {
  const limits = limitsOf(options);
  const calls: ToolCall[] = [];
  let dropped = 0;
  const record = (call: ToolCall) => {
    if (calls.length < toolCallsKept) {
      calls.push(call);
    } else {
      dropped += 1;
    }
  };
  const traced = (capability: Capability) =>
    Host.fn((args) =>
      Effect.gen(function* callCapability() {
        const started = yield* Clock.currentTimeMillis;
        const done = Effect.fnUntraced(function* recordCall(ok: boolean) {
          const now = yield* Clock.currentTimeMillis;
          record({ ms: now - started, ok, path: capability.path });
        });
        const input = yield* decodeInput(args[0]).pipe(
          Effect.mapError(() =>
            Host.fail(
              "InvalidInput",
              `${capability.path}: the input is not JSON`
            )
          )
        );
        return yield* capability.call(input).pipe(
          Effect.tap(() => done(true)),
          Effect.tapError(() => done(false))
        );
      })
    );
  const namespaceOf = (namespace: string) =>
    Host.namespace({
      keys: (path) =>
        path.length === 0
          ? byNamespace(namespace).map((each) => each.name)
          : [],
      resolve: (path) => {
        const capability = byNamespace(namespace).find(
          (each) => path.length === 1 && each.name === path[0]
        );
        const wanted = `${namespace}.${path.join(".")}`;
        return capability === undefined
          ? Host.missing(
              `${wanted} is not a function`,
              suggest(
                wanted,
                catalog.map((each) => each.path)
              )
            )
          : traced(capability);
      },
    });
  const globals = Object.fromEntries(
    Object.keys(namespaces).map((namespace) => [
      namespace,
      namespaceOf(namespace),
    ])
  );
  const runtime = Runtime.make({
    globals: () => globals,
    limits,
    translate: { functions: "drop", promises: "await" },
  });
  const result = yield* runtime.execute(code);
  const common = {
    limits,
    logs: result.logs ?? [],
    toolCalls: calls,
    toolCallsDropped: dropped,
    truncated: result.truncated ?? false,
  };
  return (
    result.ok
      ? {
          ...common,
          ok: true,
          value: result.value,
          warnings: result.warnings ?? [],
        }
      : { ...common, error: result.error, ok: false, warnings: [] }
  ) satisfies CodemodeResult;
}, Effect.withSpan("codemode.execute"));
