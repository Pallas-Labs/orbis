import { expect, test } from "bun:test";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";

import { decodePlaybackDiagnosticsBatch } from "@orbis/contracts/http-api";

import { createTestApp } from "./test-app.js";

const fixture = decodePlaybackDiagnosticsBatch(
  JSON.parse(
    readFileSync(
      new URL("fixtures/playback-upload.json", import.meta.url),
      "utf-8"
    )
  )
);

const artifact = path.resolve(import.meta.dir, "../../../.cache/signoz");
const batch = () => structuredClone(fixture);
const post = (body = JSON.stringify(batch()), headers: HeadersInit = {}) =>
  new Request("http://localhost/diagnostics/playback", {
    body,
    headers: {
      "content-type": "application/json",
      "x-orbis-test-auth": "fixture",
      ...Object.fromEntries(new Headers(headers)),
    },
    method: "POST",
  });

const setup = (
  respond: (request: Request) => Response | Promise<Response> = () =>
    Response.json({})
) => {
  const requests: { headers: Headers; body: unknown }[] = [];
  const collector = Bun.serve({
    fetch: async (request) => {
      // The relay only POSTs. On a dev machine, a local tool (T3's port scan) can GET any
      // new port, and that probe must not count as an export.
      if (request.method !== "POST") {
        return new Response(null, { status: 404 });
      }
      requests.push({ body: await request.json(), headers: request.headers });
      return respond(request);
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const app = createTestApp({
    logging: { silent: true },
    playbackDiagnostics: {
      accessClientId: "test-id",
      accessClientSecret: "test-secret",
      environment: "test",
      url: collector.url.toString(),
    },
  });
  return {
    app,
    close: async () => {
      await app.dispose();
      await collector.stop(true);
    },
    collector,
    requests,
    send: (body = JSON.stringify(batch())) => app.handler(post(body), "device"),
  };
};

test("valid authenticated native fixture reaches playback endpoint and exports OTLP", async () => {
  const s = setup();
  try {
    const initialized = await s.app.initialize();
    expect(initialized.status).toBe(200);
    const response = await s.send();
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect(receipt).toEqual({ accepted: fixture.entries.length, rejected: 0 });
    expect(s.requests).toHaveLength(1);
    const [request] = s.requests;
    expect(request?.headers.get("user-agent")).toBe("Orbis-Playback-Relay/1");
    expect(request?.headers.get("cf-access-client-id")).toBe("test-id");
    expect(request?.headers.get("cf-access-client-secret")).toBe("test-secret");
    const text = JSON.stringify(request?.body);
    expect(text).toContain("orbis-apple");
    expect(text).not.toContain("orbis.apple.playback");
    expect(text).toContain(fixture.runId);
    expect(text).toContain("timeUnixNano");
    expect(text).not.toContain("test-secret");
    await mkdir(artifact, { recursive: true });
    await writeFile(
      path.join(artifact, "native-replay-otlp.json"),
      JSON.stringify(request?.body, null, 2)
    );
    await writeFile(
      path.join(artifact, "receipt.json"),
      JSON.stringify(receipt)
    );
    const broadReplay = await s.send(
      readFileSync(
        new URL("fixtures/playback-report-upload.json", import.meta.url),
        "utf-8"
      )
    );
    expect(broadReplay.status).toBe(200);
    expect(await broadReplay.json()).toEqual({ accepted: 20, rejected: 0 });
    expect(s.requests).toHaveLength(2);
    await writeFile(
      path.join(artifact, "broad-replay-otlp.json"),
      JSON.stringify(s.requests[1]?.body, null, 2)
    );
  } finally {
    await s.close();
  }
});

interface OtlpAttribute {
  key: string;
  value: Record<string, string | number | boolean>;
}
interface OtlpBody {
  resourceLogs: {
    resource: { attributes: OtlpAttribute[] };
    scopeLogs: {
      logRecords: { attributes: OtlpAttribute[]; severityText: string }[];
    }[];
  }[];
}
const isOtlpBody = (body: unknown): body is OtlpBody =>
  typeof body === "object" &&
  body !== null &&
  "resourceLogs" in body &&
  Array.isArray(body.resourceLogs);
type Entry = (typeof fixture.entries)[number];
const attributeMap = (attributes: OtlpAttribute[]) =>
  Object.fromEntries(attributes.map(({ key, value }) => [key, value]));
const recordsOf = (body: OtlpBody) =>
  (body.resourceLogs[0]?.scopeLogs[0]?.logRecords ?? []).map((record) =>
    attributeMap(record.attributes)
  );

test("OTLP records carry resource attributes, event attributes, and the Set ID", async () => {
  const s = setup();
  try {
    const [first] = fixture.entries;
    if (!first) {
      throw new Error("fixture is empty");
    }
    const entry = (
      sequence: number,
      event: Entry["event"],
      snapshot: Partial<Entry["snapshot"]> = {}
    ): Entry => ({
      ...first,
      event,
      sequence,
      snapshot: { ...first.snapshot, ...snapshot },
    });
    const body = {
      ...batch(),
      afterSequence: 0,
      entries: [
        entry(
          1,
          { command: { _0: { kind: "seek", origin: "app", target: 8.5 } } },
          { setId: "set-42" }
        ),
        entry(2, {
          seekResult: {
            _0: {
              actual: 8.4,
              duration: 0.25,
              finished: true,
              seekID: 1,
              target: 8.5,
            },
          },
        }),
        entry(3, {
          item: {
            _0: { error: { code: -1009, domain: "url" }, phase: "failed" },
          },
        }),
        entry(4, { state: { _0: { from: "playing", to: "paused" } } }),
      ],
      throughSequence: 4,
    };
    const response = await s.send(JSON.stringify(body));
    expect(response.status).toBe(200);
    // The loopback collector stores the JSON body the relay posted; isOtlpBody
    // narrows it to the OTLP shape the assertions read.
    const sent = s.requests[0]?.body;
    if (!isOtlpBody(sent)) {
      throw new Error("the relay did not post an OTLP body");
    }
    expect(
      attributeMap(sent.resourceLogs[0]?.resource.attributes ?? [])
    ).toEqual({
      "app.build_id": { stringValue: fixture.metadata.appBuild },
      "deployment.environment.name": { stringValue: "test" },
      "os.name": { stringValue: fixture.metadata.osName },
      "os.version": { stringValue: fixture.metadata.osVersion },
      "service.name": { stringValue: "orbis-apple" },
      "service.namespace": { stringValue: "orbis" },
      "service.version": { stringValue: fixture.metadata.appVersion },
    });
    const [command, seek, item, state] = recordsOf(sent);
    expect(command).toMatchObject({
      "orbis.set_id": { stringValue: "set-42" },
      "playback.command.kind": { stringValue: "seek" },
      "playback.command.origin": { stringValue: "app" },
      "playback.command.target": { doubleValue: 8.5 },
      "session.id": { stringValue: fixture.runId },
    });
    expect(command).not.toHaveProperty("orbis.run_id");
    expect(command).not.toHaveProperty("app.version");
    expect(seek).toMatchObject({
      "playback.seek.duration": { doubleValue: 0.25 },
      "playback.seek.finished": { boolValue: true },
    });
    expect(seek).not.toHaveProperty("orbis.set_id");
    expect(item).toMatchObject({
      "error.type": { stringValue: "url:-1009" },
      "playback.phase": { stringValue: "failed" },
    });
    expect(state).toMatchObject({
      "playback.state.from": { stringValue: "playing" },
    });
  } finally {
    await s.close();
  }
});

test("strict nested privacy schema rejects unknown fields and inconsistent sequences", async () => {
  const s = setup();
  try {
    const [first] = fixture.entries;
    expect(first).toBeDefined();
    if (!first) {
      throw new Error("fixture is empty");
    }
    const base = {
      ...batch(),
      afterSequence: 0,
      entries: [first],
      throughSequence: first.sequence,
    };
    const invalid: object[] = [
      { ...base, secret: "private" },
      { ...base, metadata: { ...base.metadata, token: "private" } },
      { ...base, metadata: { ...base.metadata, appBuild: "x".repeat(65) } },
      { ...base, entries: [{ ...first, title: "private" }] },
      {
        ...base,
        entries: [{ ...first, event: { sample: { url: "private" } } }],
      },
      {
        ...base,
        entries: [
          {
            ...first,
            event: {
              command: {
                _0: {
                  kind: "play",
                  origin: "app",
                  target: null,
                  token: "private",
                },
              },
            },
          },
        ],
      },
      {
        ...base,
        entries: [
          {
            ...first,
            snapshot: { ...first.snapshot, errorDescription: "private" },
          },
        ],
      },
      {
        ...base,
        entries: [
          {
            ...first,
            snapshot: {
              ...first.snapshot,
              bufferRanges: [{ duration: 1, start: 0, url: "private" }],
            },
          },
        ],
      },
      {
        ...base,
        entries: [
          {
            ...first,
            snapshot: {
              ...first.snapshot,
              bufferRanges: Array.from({ length: 9 }, () => ({
                duration: 1,
                start: 0,
              })),
            },
          },
        ],
      },
      {
        ...base,
        entries: [
          {
            ...first,
            snapshot: {
              ...first.snapshot,
              access: {
                bytesTransferred: 0,
                downloadedDuration: 0,
                indicatedBitrate: 0,
                observedBitrate: 0,
                stalls: 0,
                transferDuration: 0,
                url: "private",
              },
            },
          },
        ],
      },
      {
        ...base,
        entries: [
          { ...first, snapshot: { ...first.snapshot, setId: "x".repeat(129) } },
        ],
      },
      {
        ...base,
        entries: [
          { ...first, snapshot: { ...first.snapshot, secretKey: "private" } },
        ],
      },
      { ...base, schemaVersion: 2 },
      { ...base, runId: "private-device-name" },
      { ...base, afterSequence: first.sequence },
      { ...base, lost: [{ afterSequence: 3, throughSequence: 3 }] },
      {
        ...base,
        lost: [{ afterSequence: 0, private: "x", throughSequence: 1 }],
      },
      {
        ...base,
        lost: Array.from({ length: 33 }, (_, index) => ({
          afterSequence: index,
          throughSequence: index + 1,
        })),
      },
      { ...base, entries: [], throughSequence: base.afterSequence },
      { ...base, throughSequence: first.sequence - 1 },
      { ...base, entries: [first, first] },
      {
        ...base,
        entries: [{ ...first, wallTime: 18_446_744_073_710 }],
      },
      {
        ...base,
        entries: [{ ...first, sequence: Number.MAX_SAFE_INTEGER + 1 }],
      },
      {
        ...base,
        entries: Array.from({ length: 33 }, (_, index) => ({
          ...first,
          sequence: index + 1,
        })),
        throughSequence: 33,
      },
    ];
    const assertInvalid = async (index: number): Promise<void> => {
      const body = invalid[index];
      if (!body) {
        return;
      }
      const response = await s.send(JSON.stringify(body));
      expect(response.status).toBe(400);
      return assertInvalid(index + 1);
    };
    await assertInvalid(0);
    const nonfinite = JSON.stringify(base).replace(
      /"uptime":[0-9.]+/u,
      '"uptime":1e999'
    );
    const response = await s.app.handler(
      new Request(post(), { body: nonfinite, method: "POST" }),
      "device"
    );
    expect(response.status).toBe(400);
    expect(s.requests).toHaveLength(0);
    const unauthorized = await s.app.handler(
      post(JSON.stringify(batch()), { authorization: "Bearer invalid" }),
      "device"
    );
    expect(unauthorized.status).toBe(401);
    const tokenFree = await s.app.handler(
      new Request("http://localhost/diagnostics/playback", {
        body: JSON.stringify(batch()),
        method: "POST",
      }),
      "device"
    );
    expect(tokenFree.status).toBe(403);
  } finally {
    await s.close();
  }
});

test.each([
  { collectorStatus: 429, relayStatus: 503 },
  { collectorStatus: 502, relayStatus: 503 },
  { collectorStatus: 503, relayStatus: 503 },
  { collectorStatus: 504, relayStatus: 503 },
  { collectorStatus: 400, relayStatus: 500 },
  { collectorStatus: 401, relayStatus: 500 },
  { collectorStatus: 403, relayStatus: 500 },
  { collectorStatus: 500, relayStatus: 500 },
  { collectorStatus: 302, relayStatus: 500 },
])(
  "collector $collectorStatus maps to terminal relay $relayStatus without server retry",
  async ({ collectorStatus, relayStatus }) => {
    const s = setup(
      () =>
        new Response("private collector error", {
          headers: {
            location: "http://127.0.0.1:1/private",
            "retry-after": "301",
          },
          status: collectorStatus,
        })
    );
    try {
      const response = await s.send();
      expect(response.status).toBe(relayStatus);
      expect(await response.text()).not.toContain("private");
      if (relayStatus === 503) {
        expect(response.headers.get("retry-after")).toBe("301");
      }
      expect(s.requests).toHaveLength(1);
    } finally {
      await s.close();
    }
  }
);

test("playback.loss is written only for the ranges the client declares, with their exact bounds", async () => {
  const s = setup();
  try {
    const [first] = fixture.entries;
    if (!first) {
      throw new Error("fixture is empty");
    }
    const send = async (body: Partial<typeof fixture>) => {
      const response = await s.send(JSON.stringify({ ...batch(), ...body }));
      expect(response.status).toBe(200);
      return response.json();
    };
    // A batch that follows an unacknowledged one: sequences 1 to 7 are behind it, but the
    // client declared none of them lost, so they may already be stored.
    expect(
      await send({
        afterSequence: 0,
        entries: [{ ...first, sequence: 8 }],
        throughSequence: 8,
      })
    ).toEqual({ accepted: 1, rejected: 0 });
    expect(
      await send({
        afterSequence: 19,
        entries: [{ ...first, sequence: 20 }],
        lost: [
          { afterSequence: 8, throughSequence: 12 },
          { afterSequence: 14, throughSequence: 19 },
        ],
        throughSequence: 20,
      })
    ).toEqual({ accepted: 3, rejected: 0 });
    // A declaration with no entries, as after a refused batch with nothing newer to send.
    expect(
      await send({
        afterSequence: 25,
        entries: [],
        lost: [{ afterSequence: 20, throughSequence: 25 }],
        throughSequence: 25,
      })
    ).toEqual({ accepted: 1, rejected: 0 });
    const losses = s.requests.map(({ body }) => {
      if (!isOtlpBody(body)) {
        throw new Error("the relay did not post an OTLP body");
      }
      return recordsOf(body)
        .filter(
          (record) => record["event.name"]?.stringValue === "playback.loss"
        )
        .map((record) => ({
          after: record["playback.after_sequence"],
          count: record["playback.lost_count"],
          through: record["playback.through_sequence"],
        }));
    });
    expect(losses).toEqual([
      [],
      [
        {
          after: { intValue: "8" },
          count: { intValue: "4" },
          through: { intValue: "12" },
        },
        {
          after: { intValue: "14" },
          count: { intValue: "5" },
          through: { intValue: "19" },
        },
      ],
      [
        {
          after: { intValue: "20" },
          count: { intValue: "5" },
          through: { intValue: "25" },
        },
      ],
    ]);
  } finally {
    await s.close();
  }
});

test("partial receipt produces bounded searchable records without retry", async () => {
  const s = setup(() =>
    Response.json({
      partialSuccess: { errorMessage: "private", rejectedLogRecords: "1" },
    })
  );
  try {
    const [first] = fixture.entries;
    if (!first) {
      throw new Error("fixture is empty");
    }
    const response = await s.send(
      JSON.stringify({
        ...batch(),
        afterSequence: 4,
        entries: [{ ...first, sequence: 5 }],
        lost: [{ afterSequence: 0, throughSequence: 4 }],
        throughSequence: 5,
      })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 1, rejected: 1 });
    expect(s.requests).toHaveLength(1);
    const text = JSON.stringify(s.requests[0]?.body);
    expect(text).toContain("playback.loss");
    expect(text).toContain('"intValue":"4"');
    expect(text).not.toContain("private");
  } finally {
    await s.close();
  }
});

test("actual chunked body over 64 KiB is refused before the caller finishes sending", async () => {
  const s = setup();
  const server = Bun.serve({
    fetch: (request) => s.app.handler(request, "device"),
    hostname: "127.0.0.1",
    maxRequestBodySize: 2 ** 20,
    port: 0,
  });
  try {
    const socket = connect(Number(server.url.port), "127.0.0.1");
    let response = "";
    try {
      socket.setTimeout(3000, () =>
        socket.destroy(
          new Error("application waited for EOF instead of limiting chunks")
        )
      );
      await once(socket, "connect");
      const incoming = once(socket, "data");
      socket.write(
        "POST /diagnostics/playback HTTP/1.1\r\nHost: localhost\r\nX-Orbis-Test-Auth: fixture\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
      );
      for (let i = 0; i < 17; i += 1) {
        socket.write(`1000\r\n${" ".repeat(4096)}\r\n`);
      }
      const [chunk] = await incoming;
      response = String(chunk);
    } finally {
      socket.destroy();
    }
    expect(response).toContain("413");
    expect(s.requests).toHaveLength(0);
  } finally {
    await server.stop(true);
    await s.close();
  }
});

test("two active exports have no queue and deadline releases both slots", async () => {
  const s = setup(async () => {
    await Bun.sleep(6500);
    return Response.json({});
  });
  try {
    const first = s.send();
    const second = s.send();
    const waitForExports = async (attemptsLeft = 200): Promise<void> => {
      if (s.requests.length >= 2 || attemptsLeft <= 0) {
        return;
      }
      await Bun.sleep(10);
      return waitForExports(attemptsLeft - 1);
    };
    await waitForExports();
    expect(s.requests).toHaveLength(2);
    const excess = await s.send();
    expect(excess.status).toBe(503);
    expect(s.requests).toHaveLength(2);
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.status)).toEqual([503, 503]);
    const next = await s.send();
    expect(next.status).toBe(503);
    expect(s.requests).toHaveLength(3);
  } finally {
    await s.close();
  }
});

test.each([
  () => new Response("x".repeat(65_537)),
  () =>
    Response.json({
      partialSuccess: { rejectedLogRecords: "999999999999999999999" },
    }),
  () => Response.json({ partialSuccess: { rejectedLogRecords: "-1" } }),
])(
  "invalid collector receipt is bounded and never echoed",
  async (response) => {
    const s = setup(response);
    try {
      const relayResponse = await s.send();
      expect(relayResponse.status).toBe(500);
      expect(s.requests).toHaveLength(1);
    } finally {
      await s.close();
    }
  }
);

test("missing exporter configuration is retryable", async () => {
  const app = createTestApp({ logging: { silent: true } });
  try {
    const response = await app.handler(post(), "device");
    expect(response.status).toBe(503);
  } finally {
    await app.dispose();
  }
});
