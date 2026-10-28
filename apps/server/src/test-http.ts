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
  const base = options.host
    ? `http://${options.host}`
    : "http://127.0.0.1:4310";
  const response = await app.handler(
    new Request(`${base}${options.url}`, init),
    options.accessMode ?? "device",
    options.clientAddress
  );
  const body = await response.json();
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
