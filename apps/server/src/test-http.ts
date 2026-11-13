import { Schema } from "effect";

import type { createApp } from "./app.js";
import type { AccessMode } from "./identity.js";

interface TestHeaders extends Record<string, string> {
  "x-orbis-test-auth": string;
}

export const request = async (
  app: ReturnType<typeof createApp>,
  options: {
    method: string;
    url: string;
    payload?: unknown;
    headers?: Record<string, string>;
    host?: string;
    accessMode?: AccessMode;
    clientAddress?: string;
  }
) => {
  const headers: TestHeaders = { "x-orbis-test-auth": "fixture" };
  const init: RequestInit = { headers, method: options.method };
  if (options.payload !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.payload);
  }
  Object.assign(headers, options.headers);
  const base =
    options.host !== undefined && options.host !== ""
      ? `http://${options.host}`
      : "http://127.0.0.1:4310";
  const response = await app.handler(
    new Request(`${base}${options.url}`, init),
    options.accessMode ?? "device",
    options.clientAddress
  );
  // A request the API schema refuses answers with an empty body.
  const text = await response.text();
  const body = text === "" ? null : JSON.parse(text);
  return {
    headers: response.headers,
    json: () => body,
    statusCode: response.status,
  };
};

export type TestResponse = Awaited<ReturnType<typeof request>>;

const SavedId = Schema.Struct({ id: Schema.String });
const decodeSavedId = Schema.decodeUnknownSync(SavedId);

/** The `id` field a JSON response carried, decoded here so a bad shape fails the test. */
export const idIn = (response: TestResponse): string =>
  decodeSavedId(response.json()).id;

/**
 * Time from `origin` to `at` as `+2m`, `+1m59.999s` or `+0s`, so a transcript
 * shows times against the test clock rather than as dates.
 */
export const relativeTime = (at: number, origin: number): string => {
  const elapsed = at - origin;
  const sign = elapsed < 0 ? "-" : "+";
  const minutes = Math.floor(Math.abs(elapsed) / 60_000);
  const seconds = (Math.abs(elapsed) % 60_000) / 1000;
  const parts = [
    minutes > 0 ? `${minutes}m` : "",
    seconds > 0 || minutes === 0 ? `${seconds}s` : "",
  ];
  return `${sign}${parts.join("")}`;
};

/**
 * A test's steps as text a person reads, one `request  -> answer` line per
 * step, for an inline snapshot. `name` gives each random value (a code, a
 * secret, a key, a Set id) a numbered placeholder such as `<code 1>` the first
 * time it appears and the same one after, so the text is the same every run.
 */
export const transcript = () => {
  const placeholders = new Map<string, string>();
  const counts = new Map<string, number>();
  const lines: string[] = [];
  return {
    name: (kind: string, value: string) => {
      const known = placeholders.get(value);
      if (known !== undefined) {
        return known;
      }
      const count = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, count);
      const placeholder = `<${kind} ${count}>`;
      placeholders.set(value, placeholder);
      return placeholder;
    },
    step: (step: string, answer: string) => {
      lines.push(`${step}  -> ${answer}`);
    },
    text: () => `\n${lines.join("\n")}\n`,
  };
};

/**
 * Runs `run` once for each item, one at a time in the order given. A test that
 * paces a client against a rate limit depends on that order, and
 * `no-await-in-loop` cannot tell it apart from a loop that should run in
 * parallel, so the sequencing lives here rather than in a suppressed loop. A
 * throwing step stops the rest, as a `for … await` loop does.
 */
export const runInOrder = async <Item>(
  items: Iterable<Item>,
  run: (item: Item, index: number) => Promise<void>
): Promise<void> => {
  const iterator = items[Symbol.iterator]();
  const step = async (index: number): Promise<void> => {
    const next = iterator.next();
    if (next.done === true) {
      return;
    }
    await run(next.value, index);
    await step(index + 1);
  };
  await step(0);
};

/** `runInOrder` over the indexes from `0` to `count - 1`. */
export const runTimesInOrder = async (
  count: number,
  run: (index: number) => Promise<void>
): Promise<void> => {
  const indexes = Array.from({ length: count }, (_, index) => index);
  await runInOrder(indexes, run);
};

/**
 * Waits until `check` holds, looking again every `interval` ms and failing after
 * `attempts` tries with `message`. A suite that watches a worker, a download or
 * a lease reach a state waits here, so the wait is stated once instead of as a
 * suppressed polling loop in every file that needs one.
 */
export const waitUntil = async (
  check: () => boolean | Promise<boolean>,
  options: { attempts?: number; interval?: number; message?: string } = {}
): Promise<void> => {
  const {
    attempts = 1000,
    interval = 10,
    message = "The expected state did not arrive",
  } = options;
  const attempt = async (tryNumber: number): Promise<void> => {
    if (await check()) {
      return;
    }
    if (tryNumber >= attempts) {
      throw new Error(message);
    }
    await Bun.sleep(interval);
    await attempt(tryNumber + 1);
  };
  await attempt(0);
};

/**
 * Waits until `check` answers something other than `null` or `undefined`, and
 * returns that answer. A journey that polls a cache or an endpoint until it
 * reports the state it waits for reads the answer here, so the wait is stated
 * once instead of as a suppressed polling loop in every journey that needs one.
 */
export const pollUntil = async <Value>(
  check: () => Promise<Value | null | undefined>,
  options: { attempts?: number; interval?: number; message?: string } = {}
): Promise<Value> => {
  const {
    attempts = 1000,
    interval = 10,
    message = "The expected answer did not arrive",
  } = options;
  const attempt = async (tryNumber: number): Promise<Value> => {
    const answer = await check();
    if (answer !== null && answer !== undefined) {
      return answer;
    }
    if (tryNumber >= attempts) {
      throw new Error(message);
    }
    await Bun.sleep(interval);
    return await attempt(tryNumber + 1);
  };
  return await attempt(0);
};

/**
 * One `text/event-stream` response, read frame by frame. `next` gives the
 * `data:` payload of the next frame, decoded by the caller, or `null` once the
 * server closes the stream. Reading chunk by chunk is a loop that waits inside
 * itself, so the reading lives here rather than in a suppressed loop in every
 * suite that opens a stream.
 */
export const eventStream = (response: Response) => {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("The event response has no stream");
  }
  const decoder = new TextDecoder();
  let pending = "";
  const fill = async (): Promise<string | null> => {
    if (pending.includes("\n\n")) {
      return pending;
    }
    const chunk = await reader.read();
    if (chunk.done) {
      return null;
    }
    pending += decoder.decode(chunk.value, { stream: true });
    return await fill();
  };
  return {
    close: async (): Promise<void> => {
      try {
        await reader.cancel();
      } catch {
        // A reader the server already closed rejects the cancel.
      }
    },
    next: async (): Promise<string | null> => {
      const filled = await fill();
      if (filled === null) {
        return null;
      }
      const boundary = filled.indexOf("\n\n");
      const frame = filled.slice(0, boundary);
      pending = filled.slice(boundary + 2);
      return frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
    },
  };
};

const isRefusal = Schema.is(Schema.Struct({ message: Schema.String }));

/** A status, with the sentence a refusal carried: `404 "Not found."`. */
export const statusLine = (
  response: Pick<TestResponse, "json" | "statusCode">
): string => {
  const body = response.json();
  return isRefusal(body)
    ? `${response.statusCode} "${body.message}"`
    : String(response.statusCode);
};
