import { afterEach, expect, test } from "bun:test";

import { Effect } from "effect";

import {
  configureLogging,
  flushLogs,
  logEvent,
  loggingLayer,
} from "./logging.js";
import { createTestApp as createApp } from "./test-app.js";
import { request } from "./test-http.js";

interface OtlpAttribute {
  readonly key: string;
  readonly value: { readonly stringValue?: string; readonly intValue?: string };
}
interface OtlpRecord {
  readonly attributes: readonly OtlpAttribute[];
  readonly severityText: string;
}
interface OtlpBody {
  readonly resourceLogs: readonly {
    readonly resource: { readonly attributes: readonly OtlpAttribute[] };
    readonly scopeLogs: readonly {
      readonly logRecords: readonly OtlpRecord[];
    }[];
  }[];
}

const startCollector = () => {
  const received: { body: OtlpBody; headers: Headers; path: string }[] = [];
  const server = Bun.serve({
    fetch: async (incoming) => {
      received.push({
        body: await incoming.json(),
        headers: incoming.headers,
        path: new URL(incoming.url).pathname,
      });
      return Response.json({});
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  return { received, server };
};

const attribute = (attributes: readonly OtlpAttribute[], key: string) => {
  const found = attributes.find((entry) => entry.key === key)?.value;
  return found?.stringValue ?? found?.intValue;
};

const records = (bodies: readonly OtlpBody[]) =>
  bodies.flatMap((body) =>
    body.resourceLogs.flatMap((resource) =>
      resource.scopeLogs.flatMap((scope) =>
        scope.logRecords.map((record) => ({
          ...record,
          resource: resource.resource.attributes,
        }))
      )
    )
  );

afterEach(() => {
  configureLogging({ silent: true });
});

test("drains events, request events, and plain Effect logs to the OTLP collector", async () => {
  const { received, server } = startCollector();
  const otlp = {
    component: "node",
    headers: { "x-probe": "fixture" },
    url: `http://127.0.0.1:${server.port}/v1/logs`,
  } as const;
  const app = createApp({ logging: { otlp, silent: true } });
  try {
    logEvent("error", { event: "probe", token: "do-not-send" });
    await Effect.runPromise(
      Effect.logWarning("plain line").pipe(
        Effect.annotateLogs({ set: "set-1" }),
        Effect.provide(loggingLayer)
      )
    );
    await request(app, { method: "GET", url: "/health?token=hidden" });
    await flushLogs();
  } finally {
    await app.dispose();
    await server.stop(true);
  }
  expect(received.map((entry) => entry.path)).toContain("/v1/logs");
  expect(
    received.every((entry) => entry.headers.get("x-probe") === "fixture")
  ).toBe(true);
  const all = records(received.map((entry) => entry.body));
  for (const record of all) {
    expect(attribute(record.resource, "service.name")).toBe("orbis");
    expect(attribute(record.resource, "orbis.component")).toBe("node");
  }
  const probe = all.find(
    (record) => attribute(record.attributes, "event") === "probe"
  );
  expect(probe?.severityText).toBe("ERROR");
  const plain = all.find(
    (record) => attribute(record.attributes, "message") === "plain line"
  );
  expect(plain?.severityText).toBe("WARN");
  expect(attribute(plain?.attributes ?? [], "set")).toBe("set-1");
  const health = all.find(
    (record) => attribute(record.attributes, "path") === "/health"
  );
  expect(health?.severityText).toBe("INFO");
  const serialized = JSON.stringify(received.map((entry) => entry.body));
  expect(serialized).not.toContain("do-not-send");
  expect(serialized).not.toContain("hidden");
});
