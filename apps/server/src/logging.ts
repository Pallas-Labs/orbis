import {
  Cause,
  Context,
  Effect,
  Exit,
  Formatter,
  Logger,
  References,
  Schema,
} from "effect";
import type { LogLevel } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { createLogger, createRequestLogger, initLogger } from "evlog";
import type { DrainContext, RequestLogger, WideEvent } from "evlog";
import { createOTLPDrain } from "evlog/otlp";
import { createDrainPipeline } from "evlog/pipeline";
import type { PipelineDrainFn } from "evlog/pipeline";

/**
 * Server logging is one wide event per request, emitted once when the request
 * settles. The event carries a field set chosen here — request id, method, path
 * with the query string removed, status, outcome, and elapsed time — so an
 * authorization header, cookie, or request body is never recorded.
 *
 * Effect code may also log, and those messages and annotations are bounded and
 * redacted by key name before they are folded in. Redaction follows key names,
 * not value shapes, so a credential written as free text, or under a key that
 * does not name one, can still reach a log line: logging code must treat free
 * text as public.
 */

/** A log field the server never records, so redaction only guards accidents. */
const REDACTED_PATHS = [
  "**.authorization",
  "**.cookie",
  "**.password",
  "**.secret",
  "**.token",
];

/** The leaf names above, so `token` also covers `apiToken` and `access_token`. */
const REDACTED_KEYS = REDACTED_PATHS.map((path) =>
  path.slice(path.lastIndexOf(".") + 1).toLowerCase()
);

/**
 * True for keys that name a credential at any position: `token`, `apiToken`, and
 * `access_token` all match. Over-redacting a harmless key costs a field; missing a
 * credential costs a secret, so this check is deliberately loose.
 */
const isCredentialKey = (key: string): boolean => {
  const normalized = key.toLowerCase();
  return REDACTED_KEYS.some((word) => normalized.includes(word));
};

/** Bounds for logs an Effect program attaches to one request. */
const MAX_LOGGED_LINES = 50;
const MAX_MESSAGE_CHARACTERS = 500;
const MAX_LOGGED_VALUE_CHARACTERS = 200;
const MAX_LOGGED_VALUE_DEPTH = 4;
const MAX_LOGGED_VALUE_ENTRIES = 20;
const MAX_LOGGED_VALUE_NODES = 200;

const REDACTED_VALUE = "[redacted]";
const DROPPED_VALUE = "[unlogged]";

/** Where events go besides the console: SigNoz's OTLP/HTTP logs endpoint. */
export interface OtlpOptions {
  /** The full logs URL, such as `http://127.0.0.1:4318/v1/logs`. */
  readonly url: string;
  /** The `orbis.component` resource attribute that tells processes apart. */
  readonly component: "canary" | "group" | "node";
  readonly headers?: Readonly<Record<string, string>>;
  /** Keeps the runtime alive until queued events are sent, as a Durable Object's `ctx.waitUntil` does. */
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

export interface LoggingOptions {
  /** Recorded as the event `environment`. Defaults to `development`. */
  readonly environment?: string;
  /**
   * Called with every emitted event. The production entrypoint leaves this unset
   * so evlog writes the event to standard output; tests use it to observe events
   * without parsing console output.
   */
  readonly onEvent?: (event: WideEvent) => void;
  /**
   * Pretty output for a person at a terminal, or one JSON object per line for the
   * journal and the agents that read it. Defaults to whether stdout is a terminal.
   */
  readonly pretty?: boolean;
  /** Suppress evlog's own console output. Used by tests. */
  readonly silent?: boolean;
  /** Also send every event to this collector. Unset, events stay on the console. */
  readonly otlp?: OtlpOptions | undefined;
}

/** The collector a Bun process sends to: `ORBIS_OTLP_LOGS_URL`, or none when it is unset. */
export const otlpFromEnvironment = (
  component: OtlpOptions["component"]
): OtlpOptions | undefined => {
  const url = process.env.ORBIS_OTLP_LOGS_URL;
  return url ? { component, url } : undefined;
};

export type RequestOutcome = "success" | "rejected" | "failure" | "cancelled";

export interface RequestCompletion {
  readonly outcome: RequestOutcome;
  readonly status?: number;
}

/** Absorbs events in silent mode: evlog warns when silent output has no drain. */
const discardEvent = (context: DrainContext): void => {
  void context;
};

/** Events queued for the collector, sent in batches of up to 50 or every 5 seconds. */
let otlpBatches: PipelineDrainFn<DrainContext> | undefined;

const otlpDrain = (otlp: OtlpOptions) => {
  const batches = createDrainPipeline<DrainContext>({
    onDropped: (events, error) => {
      console.warn(
        `[orbis/logging] Dropped ${events.length} event(s) for the collector: ${error?.message ?? "queue full"}`
      );
    },
  })(
    createOTLPDrain({
      // evlog appends the signal path itself.
      endpoint: otlp.url.replace(/\/v1\/logs\/?$/u, ""),
      headers: { ...otlp.headers },
      // Flat dotted attributes, such as `audio.set`, are what SigNoz filters on.
      // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- evlog names this option.
      recordShape: "compact",
      resourceAttributes: { "orbis.component": otlp.component },
      serviceName: "orbis",
    })
  );
  otlpBatches = batches;
  return (context: DrainContext): void => {
    batches(context);
    otlp.waitUntil?.(batches.settled());
  };
};

/** Sends every queued event and waits for the collector to accept or refuse it. */
export const flushLogs = async (): Promise<void> => {
  await otlpBatches?.flush();
};

/**
 * Configures evlog once for the process. evlog keeps a single process-wide
 * logger, so a second app in the same process would share this configuration;
 * the server runs one app per process, which is the only shape it supports.
 */
export const configureLogging = (options: LoggingOptions = {}): void => {
  const env = {
    environment: options.environment ?? "development",
    service: "orbis",
  };
  const redact = { paths: REDACTED_PATHS };
  const pretty = options.pretty ?? process.stdout.isTTY === true;
  // Bun runs tests with NODE_ENV=test, so an unconfigured suite stays quiet.
  const silent = options.silent ?? process.env.NODE_ENV === "test";
  if (options.otlp !== undefined) {
    initLogger({ drain: otlpDrain(options.otlp), env, pretty, redact, silent });
    return;
  }
  if (silent) {
    initLogger({ drain: discardEvent, env, pretty, redact, silent });
    return;
  }
  initLogger({ env, pretty, redact });
};

/** The path only: a query string can carry a token or a source link. */
export const safeRequestPath = (url: string): string => {
  try {
    return new URL(url, "http://orbis.local").pathname;
  } catch {
    return "/";
  }
};

export const startRequestLog = (request: {
  readonly method: string;
  readonly path: string;
  readonly requestId: string;
}): RequestLogger =>
  createRequestLogger({
    method: request.method,
    path: request.path,
    requestId: request.requestId,
  });

export type EventLevel = "info" | "warn" | "error";

const LEVEL_RANK: Readonly<Record<EventLevel, number>> = {
  error: 2,
  info: 0,
  warn: 1,
};

/** A level work raised on its own event, which its outcome cannot lower. */
const raisedLevels = new WeakMap<RequestLogger, EventLevel>();

const levelFor = (completion: RequestCompletion): EventLevel => {
  if (completion.outcome === "failure") {
    return "error";
  }
  // A client that left, or a person who canceled, is expected.
  if (completion.outcome === "cancelled") {
    return "info";
  }
  if (completion.status !== undefined && completion.status >= 500) {
    return "error";
  }
  if (completion.status !== undefined && completion.status >= 400) {
    return "warn";
  }
  return "info";
};

/** Seals the request logger and emits its one completion event. */
export const finishRequestLog = (
  logger: RequestLogger,
  completion: RequestCompletion,
  options: LoggingOptions = {}
): void => {
  const outcomeLevel = levelFor(completion);
  const raised = raisedLevels.get(logger) ?? "info";
  logger.setLevel(
    LEVEL_RANK[raised] > LEVEL_RANK[outcomeLevel] ? raised : outcomeLevel
  );
  const event =
    completion.status === undefined
      ? logger.emit({ outcome: completion.outcome })
      : logger.emit({ outcome: completion.outcome, status: completion.status });
  if (event !== null) {
    options.onEvent?.(event);
  }
};

/** The status the router would send: the response defect it turned the failure into. */
const responseStatus = (cause: Cause.Cause<unknown>): number | undefined => {
  for (const reason of cause.reasons) {
    if (
      Cause.isDieReason(reason) &&
      HttpServerResponse.isHttpServerResponse(reason.defect)
    ) {
      return reason.defect.status;
    }
  }
  return undefined;
};

export const outcomeForStatus = (status: number): RequestOutcome => {
  if (status >= 500) {
    return "failure";
  }
  return status >= 400 ? "rejected" : "success";
};

const describeExit = (
  exit: Exit.Exit<HttpServerResponse.HttpServerResponse, unknown>
): RequestCompletion => {
  if (Exit.isSuccess(exit)) {
    const { status } = exit.value;
    return { outcome: outcomeForStatus(status), status };
  }
  const status = responseStatus(exit.cause);
  if (!Exit.hasFails(exit) && Exit.hasInterrupts(exit)) {
    // A bare interruption carries no response of its own: report it as
    // cancelled rather than inventing a status it never produced.
    return status === undefined
      ? { outcome: "cancelled" }
      : { outcome: "cancelled", status };
  }
  // A real defect with no response is the 500 the router will send.
  const failureStatus = status ?? 500;
  return { outcome: outcomeForStatus(failureStatus), status: failureStatus };
};

const CurrentWideEvent = Context.Reference<RequestLogger | null>(
  "orbis/CurrentWideEvent",
  { defaultValue: () => null }
);

/** Adds fields to the active request's wide event; outside one it does nothing. */
export const annotateWideEvent = Effect.fn("Logging.annotateWideEvent")(
  function* wideEventAnnotation(fields: LoggedRecord) {
    const logger = yield* CurrentWideEvent;
    logger?.set(fields);
  }
);

/** Raises the active wide event to at least `level`, whatever its outcome. */
export const raiseWideEventLevel = Effect.fn("Logging.raiseWideEventLevel")(
  function* wideEventLevel(level: EventLevel) {
    const logger = yield* CurrentWideEvent;
    if (logger !== null) {
      const current = raisedLevels.get(logger) ?? "info";
      if (LEVEL_RANK[level] > LEVEL_RANK[current]) {
        raisedLevels.set(logger, level);
      }
    }
  }
);

/**
 * Emits one standalone event, such as a node link change, at a chosen level. Fields
 * pass evlog's key-name redaction like every other event.
 */
export const logEvent = (
  level: EventLevel,
  fields: LoggedRecord,
  options: LoggingOptions = {}
): void => {
  const logger = createLogger({ ...fields });
  logger.setLevel(level);
  const event = logger.emit();
  if (event !== null) {
    options.onEvent?.(event);
  }
};

export const annotateForwardedRequest = (keyLabel: string | null) =>
  annotateWideEvent({ ingress: "funnel-forward", keyLabel });

const lineCounts = new WeakMap<RequestLogger, number>();

const levelOf = (logLevel: LogLevel.LogLevel): "info" | "warn" | "error" => {
  if (logLevel === "Error" || logLevel === "Fatal") {
    return "error";
  }
  return logLevel === "Warn" ? "warn" : "info";
};

/** Remaining nodes one logged value may spend, so huge or branching input stays cheap. */
interface SanitizeBudget {
  remaining: number;
}

/**
 * A logged message part, as Effect hands it over: a value with no declared type. It is
 * parsed here, once, into `LoggedValue`, and never reaches evlog unparsed.
 */
type UnparsedMessagePart = Logger.Options<unknown>["message"];

/** A record this module is willing to record, keyed by the name the logger used. */
export interface LoggedRecord {
  readonly [key: string]: LoggedValue;
}

/**
 * What survives sanitizing: strings, numbers, booleans, null, undefined, and arrays and
 * plain records of those. Class instances, functions, symbols, and cycles become a
 * placeholder, so the logged structure always formats and never grows past its bounds.
 */
type LoggedValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly LoggedValue[]
  | LoggedRecord;

const isText = Schema.is(Schema.String);
const isNumber = Schema.is(Schema.Number);
const isBoolean = Schema.is(Schema.Boolean);
const isObject = Schema.is(Schema.ObjectKeyword);

/**
 * Copies an arbitrary logged value into a plain, bounded structure whose
 * credential-named fields are replaced. The copy holds no reference to the
 * original objects, so cycles and oversized spans never reach evlog's redaction
 * walk or the formatter, and only primitives, records, and arrays survive. An
 * object with no readable entries, such as an `Error`, becomes an empty record
 * rather than leaking its non-enumerable fields.
 */
const sanitizeLoggedValue = (
  value: UnparsedMessagePart,
  depth: number,
  budget: SanitizeBudget
): LoggedValue => {
  budget.remaining -= 1;
  if (budget.remaining <= 0) {
    return DROPPED_VALUE;
  }
  if (value === undefined) {
    return undefined;
  }
  if (isText(value)) {
    return value.length > MAX_LOGGED_VALUE_CHARACTERS
      ? `${value.slice(0, MAX_LOGGED_VALUE_CHARACTERS)}…`
      : value;
  }
  if (isNumber(value) || isBoolean(value)) {
    return value;
  }
  if (value === null) {
    return null;
  }
  if (depth >= MAX_LOGGED_VALUE_DEPTH) {
    return DROPPED_VALUE;
  }
  if (Array.isArray(value)) {
    const items: LoggedValue[] = [];
    const limit = Math.min(value.length, MAX_LOGGED_VALUE_ENTRIES);
    for (let index = 0; index < limit; index += 1) {
      items.push(sanitizeLoggedValue(value[index], depth + 1, budget));
    }
    if (value.length > limit) {
      items.push(`…+${value.length - limit}`);
    }
    return items;
  }
  if (!isObject(value)) {
    return DROPPED_VALUE;
  }
  const record: { [key: string]: LoggedValue } = {};
  let count = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (count >= MAX_LOGGED_VALUE_ENTRIES) {
      record["…"] = "more";
      break;
    }
    count += 1;
    record[key] = isCredentialKey(key)
      ? REDACTED_VALUE
      : sanitizeLoggedValue(entry, depth + 1, budget);
  }
  return record;
};

const sanitizedMessage = (
  value: UnparsedMessagePart,
  budget: SanitizeBudget
): string =>
  isText(value)
    ? value
    : Formatter.format(sanitizeLoggedValue(value, 0, budget));

/** One Effect log entry as a bounded, redacted record: its message, annotations, and level. */
const sanitizedEntry = (options: Logger.Options<unknown>): LoggedRecord => {
  const budget: SanitizeBudget = { remaining: MAX_LOGGED_VALUE_NODES };
  const { message } = options;
  const text = (
    Array.isArray(message)
      ? message.map((part) => sanitizedMessage(part, budget))
      : [sanitizedMessage(message, budget)]
  ).join(" ");
  const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
  const safeAnnotations: { [key: string]: LoggedValue } = {};
  let annotationCount = 0;
  for (const [key, value] of Object.entries(annotations)) {
    if (annotationCount >= MAX_LOGGED_VALUE_ENTRIES) {
      break;
    }
    annotationCount += 1;
    safeAnnotations[key] = isCredentialKey(key)
      ? REDACTED_VALUE
      : sanitizeLoggedValue(value, 0, budget);
  }
  return {
    ...safeAnnotations,
    level: levelOf(options.logLevel),
    message:
      text.length > MAX_MESSAGE_CHARACTERS
        ? `${text.slice(0, MAX_MESSAGE_CHARACTERS)}…`
        : text,
  };
};

/**
 * Folds Effect application logs into the active request's wide event instead of
 * writing a second line. Outside a wide event, as at startup, each log becomes its
 * own event, so it reaches the same outputs. Effect log annotations, including the
 * request ones added by the middleware, ride along on each entry, and both the
 * message and the annotations are sanitized before they reach evlog.
 */
export const effectLogBridge: Logger.Logger<unknown, void> = Logger.make(
  (options: Logger.Options<unknown>) => {
    const requestLog = options.fiber.getRef(CurrentWideEvent);
    if (requestLog === null) {
      logEvent(levelOf(options.logLevel), sanitizedEntry(options));
      return;
    }
    const seen = lineCounts.get(requestLog) ?? 0;
    if (seen >= MAX_LOGGED_LINES) {
      return;
    }
    lineCounts.set(requestLog, seen + 1);
    requestLog.set({ logs: [sanitizedEntry(options)] });
  }
);

/** Why a request died, as its event records it: a name and a cleaned message, never a stack. */
export interface LoggedCause {
  readonly name: string;
  readonly message: string;
}

const QUERY_STRING = /\?[^\s"'<>]*/gu;
const BEARER_CREDENTIAL = /\bbearer\s+\S+/giu;
const CREDENTIAL_PAIR =
  /\b(?<key>[\w-]*(?:authorization|cookie|grant|password|secret|token)[\w-]*)\s*[:=]\s*[^\s,;&]+/giu;

/**
 * Error text is free text, so key-name redaction cannot reach it. This removes the
 * shapes a credential takes inside a message: a URL query string, which carries
 * stream grants, a bearer token, and a credential-named `key=value` pair.
 */
const cleanErrorText = (text: string): string => {
  const cleaned = text
    .replace(QUERY_STRING, "?[redacted]")
    .replace(BEARER_CREDENTIAL, "Bearer [redacted]")
    .replace(CREDENTIAL_PAIR, "$<key>=[redacted]");
  return cleaned.length > MAX_LOGGED_VALUE_CHARACTERS
    ? `${cleaned.slice(0, MAX_LOGGED_VALUE_CHARACTERS)}…`
    : cleaned;
};

/** A thrown or failed value, unparsed until `describeCause` reads it. */
type UnparsedFailure = Cause.Die["defect"];

export const describeCause = (value: UnparsedFailure): LoggedCause => {
  if (isObject(value) && "_tag" in value && isText(value._tag)) {
    return {
      message: value instanceof Error ? cleanErrorText(value.message) : "",
      name: value._tag,
    };
  }
  if (value instanceof Error) {
    return { message: cleanErrorText(value.message), name: value.name };
  }
  return { message: "", name: "unknown" };
};

/**
 * The failure behind a dead request, skipping the response the router turned a typed
 * failure into. A typed failure keeps only its name: a request-decoding failure's
 * message can quote the request body.
 */
const deathCause = (cause: Cause.Cause<unknown>): LoggedCause | undefined => {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) {
      return { message: "", name: describeCause(reason.error).name };
    }
    if (
      Cause.isDieReason(reason) &&
      !HttpServerResponse.isHttpServerResponse(reason.defect)
    ) {
      return describeCause(reason.defect);
    }
  }
  return undefined;
};

const requestLoggers: ReadonlySet<Logger.Logger<unknown, void>> = new Set([
  effectLogBridge,
]);

/**
 * Installs the bridge for a whole program, so work outside any wide event, such as
 * startup and the download worker's own lines, logs in the format `configureLogging` chose.
 */
export const loggingLayer = Logger.layer([effectLogBridge]);

/**
 * Wraps the router so every routed request gets exactly one wide event. The
 * event carries the request id, method, path, status, and evlog's own elapsed
 * time, and settles on success, typed failure, defect, or interruption.
 */
export const makeRequestLogMiddleware =
  (options: LoggingOptions = {}) =>
  <E, R>(
    httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    HttpServerRequest.HttpServerRequest | R
  > =>
    Effect.gen(function* logRequest() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const path = safeRequestPath(request.url);
      const requestId = crypto.randomUUID();
      const logger = startRequestLog({
        method: request.method,
        path,
        requestId,
      });
      return yield* httpEffect.pipe(
        Effect.provideService(CurrentWideEvent, logger),
        Effect.provideService(References.CurrentLoggers, requestLoggers),
        Effect.annotateLogs({ method: request.method, path, requestId }),
        Effect.onExit((exit) =>
          Effect.sync(() => {
            const cause = Exit.isFailure(exit)
              ? deathCause(exit.cause)
              : undefined;
            if (cause !== undefined) {
              logger.set({ cause });
            }
            finishRequestLog(logger, describeExit(exit), options);
          })
        )
      );
    });

/** One background job's wide event, for code that settles the job itself. */
export interface JobLog {
  readonly annotate: (fields: LoggedRecord) => void;
  /** Runs an effect with its logs folded into this event. */
  readonly within: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>;
  /** Emits the event once; a failure records its cleaned message as `reason`. */
  readonly finish: (
    outcome: Exclude<RequestOutcome, "rejected">,
    failure?: UnparsedFailure
  ) => void;
}

export const startJobLog = (
  context: LoggedRecord,
  options: LoggingOptions = {}
): JobLog => {
  const logger = createLogger({ ...context });
  return {
    annotate: (fields) => {
      logger.set(fields);
    },
    finish: (outcome, failure) => {
      if (failure !== undefined) {
        logger.set({ reason: describeCause(failure).message || "unknown" });
      }
      finishRequestLog(logger, { outcome }, options);
    },
    within: (effect) =>
      effect.pipe(
        Effect.provideService(CurrentWideEvent, logger),
        Effect.provideService(References.CurrentLoggers, requestLoggers)
      ),
  };
};

/**
 * Wraps background work, such as one audio download, in one wide event the way the
 * middleware wraps a request: Effect logs inside fold into it, with the same bounds
 * and redaction, and it emits once when the work settles.
 */
export const withWideEvent =
  (context: Readonly<Record<string, string>>, options: LoggingOptions = {}) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const job = startJobLog(context, options);
      return job.within(effect).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isSuccess(exit)) {
              job.finish("success");
            } else if (Cause.hasInterruptsOnly(exit.cause)) {
              job.finish("cancelled");
            } else {
              job.finish("failure", Cause.squash(exit.cause));
            }
          })
        )
      );
    });

/** The start of a tool's error output, where the identifying line usually is, within the value bound. */
export const outputHead = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length > MAX_LOGGED_VALUE_CHARACTERS
    ? `${trimmed.slice(0, MAX_LOGGED_VALUE_CHARACTERS - 1)}…`
    : trimmed;
};

/** The end of a tool's error output, where the cause usually is, within the value bound. */
export const outputTail = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length > MAX_LOGGED_VALUE_CHARACTERS
    ? `…${trimmed.slice(-(MAX_LOGGED_VALUE_CHARACTERS - 1))}`
    : trimmed;
};
