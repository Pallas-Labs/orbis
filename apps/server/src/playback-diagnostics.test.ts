import { expect, test } from "bun:test";
import { connect } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createTestApp } from "./test-app.js";
import fixture from "./fixtures/playback-upload.json";

const artifact = path.resolve(import.meta.dir, "../../../.cache/signoz");
const batch = () => structuredClone(fixture);
const post = (body: unknown = batch(), headers: HeadersInit = {}) =>
  new Request("http://localhost/diagnostics/playback", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-orbis-test-auth": "fixture", ...headers },
    method: "POST",
  });

const setup = (respond: (request: Request) => Response | Promise<Response> = () => Response.json({})) => {
  const requests: { headers: Headers; body: unknown }[] = [];
  const collector = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async (request) => {
      requests.push({ body: await request.json(), headers: request.headers });
      return respond(request);
    },
  });
  const app = createTestApp({
    logging: { silent: true },
    playbackDiagnostics: {
      url: collector.url.toString(), accessClientId: "test-id", accessClientSecret: "test-secret",
    },
  });
  return {
    app, collector, requests,
    close: async () => { await app.dispose(); await collector.stop(true); },
    send: (body?: unknown) => app.handler(post(body)),
  };
};

test("valid authenticated native fixture reaches playback endpoint and exports OTLP", async () => {
  const s = setup();
  try {
    expect((await s.app.initialize()).status).toBe(200);
    const response = await s.send();
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect(receipt).toEqual({ accepted: fixture.entries.length, rejected: 0 });
    expect(s.requests).toHaveLength(1);
    const request = s.requests[0];
    expect(request?.headers.get("user-agent")).toBe("Orbis-Playback-Relay/1");
    expect(request?.headers.get("cf-access-client-id")).toBe("test-id");
    expect(request?.headers.get("cf-access-client-secret")).toBe("test-secret");
    const text = JSON.stringify(request?.body);
    expect(text).toContain("orbis.apple.playback");
    expect(text).toContain(fixture.runId);
    expect(text).toContain("timeUnixNano");
    expect(text).not.toContain("test-secret");
    await mkdir(artifact, { recursive: true });
    await writeFile(path.join(artifact, "native-replay-otlp.json"), JSON.stringify(request?.body, null, 2));
    await writeFile(path.join(artifact, "receipt.json"), JSON.stringify(receipt));
  } finally { await s.close(); }
});

test("strict nested privacy schema rejects unknown fields and inconsistent sequences", async () => {
  const s = setup();
  try {
    const first = fixture.entries[0];
    expect(first).toBeDefined();
    if (!first) { throw new Error("fixture is empty"); }
    const base = { ...batch(), afterSequence: 0, throughSequence: first.sequence, entries: [first] };
    const invalid: unknown[] = [
      { ...base, secret: "private" },
      { ...base, metadata: { ...base.metadata, token: "private" } },
      { ...base, metadata: { ...base.metadata, appBuild: "x".repeat(65) } },
      { ...base, entries: [{ ...first, title: "private" }] },
      { ...base, entries: [{ ...first, event: { sample: { url: "private" } } }] },
      { ...base, entries: [{ ...first, event: { command: { _0: { kind: "play", origin: "app", target: null, token: "private" } } } }] },
      { ...base, entries: [{ ...first, snapshot: { ...first.snapshot, errorDescription: "private" } }] },
      { ...base, entries: [{ ...first, snapshot: { ...first.snapshot, bufferRanges: [{ start: 0, duration: 1, url: "private" }] } }] },
      { ...base, entries: [{ ...first, snapshot: { ...first.snapshot, bufferRanges: Array.from({ length: 9 }, () => ({ start: 0, duration: 1 })) } }] },
      { ...base, entries: [{ ...first, snapshot: { ...first.snapshot, access: { bytesTransferred: 0, transferDuration: 0, observedBitrate: 0, indicatedBitrate: 0, stalls: 0, downloadedDuration: 0, url: "private" } } }] },
      { ...base, schemaVersion: 2 }, { ...base, runId: "private-device-name" },
      { ...base, afterSequence: first.sequence },
      { ...base, throughSequence: first.sequence - 1 },
      { ...base, entries: [first, first] },
      { ...base, entries: [{ ...first, sequence: Number.MAX_SAFE_INTEGER + 1 }] },
      { ...base, entries: Array.from({ length: 33 }, (_, index) => ({ ...first, sequence: index + 1 })), throughSequence: 33 },
    ];
    for (const body of invalid) { expect((await s.send(body)).status).toBe(400); }
    const nonfinite = JSON.stringify(base).replace('"uptime":', '"uptime":1e999,"unused":');
    const response = await s.app.handler(new Request(post(), { body: nonfinite }));
    expect(response.status).toBe(400);
    expect(s.requests).toHaveLength(0);
    expect((await s.app.handler(post(batch(), { authorization: "Bearer invalid" }))).status).toBe(401);
    expect((await s.app.handler(new Request("http://localhost/diagnostics/playback", { method: "POST", body: JSON.stringify(batch()) }), "local")).status).toBe(403);
  } finally { await s.close(); }
});

for (const [collectorStatus, relayStatus] of [[429, 503], [502, 503], [503, 503], [504, 503], [400, 500], [401, 500], [403, 500], [500, 500], [302, 500]]) {
  test(`collector ${collectorStatus} maps to terminal relay ${relayStatus} without server retry`, async () => {
    const s = setup(() => new Response("private collector error", { status: collectorStatus, headers: { "retry-after": "301", location: "http://127.0.0.1:1/private" } }));
    try {
      const response = await s.send();
      expect(response.status).toBe(relayStatus);
      expect(await response.text()).not.toContain("private");
      if (relayStatus === 503) { expect(response.headers.get("retry-after")).toBe("301"); }
      expect(s.requests).toHaveLength(1);
    } finally { await s.close(); }
  });
}

test("partial receipt and sequence holes produce bounded searchable records without retry", async () => {
  const s = setup(() => Response.json({ partialSuccess: { rejectedLogRecords: "1", errorMessage: "private" } }));
  try {
    const first = fixture.entries[0];
    if (!first) { throw new Error("fixture is empty"); }
    const response = await s.send({ ...batch(), afterSequence: 0, throughSequence: 5, entries: [{ ...first, sequence: 2 }] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 1, rejected: 1 });
    expect(s.requests).toHaveLength(1);
    const text = JSON.stringify(s.requests[0]?.body);
    expect(text).toContain("playback.loss");
    expect(text).toContain('"intValue":"4"');
    expect(text).not.toContain("private");
  } finally { await s.close(); }
});

test("actual chunked body over 64 KiB is refused before the caller finishes sending", async () => {
  const s = setup();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 2 ** 20, fetch: (request) => s.app.handler(request) });
  try {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(server.port, "127.0.0.1");
      let output = "";
      socket.setTimeout(3000, () => { socket.destroy(); reject(new Error("application waited for EOF instead of limiting chunks")); });
      socket.on("error", reject);
      socket.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes("\r\n\r\n")) { socket.destroy(); resolve(output); }
      });
      socket.on("connect", () => {
        socket.write("POST /diagnostics/playback HTTP/1.1\r\nHost: localhost\r\nX-Orbis-Test-Auth: fixture\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n");
        for (let i = 0; i < 17; i++) { socket.write(`1000\r\n${" ".repeat(4096)}\r\n`); }
      });
    });
    expect(response).toContain("413");
    expect(s.requests).toHaveLength(0);
  } finally { await server.stop(true); await s.close(); }
});

test("two active exports have no queue and deadline releases both slots", async () => {
  const s = setup(async () => { await Bun.sleep(6500); return Response.json({}); });
  try {
    const first = s.send(); const second = s.send();
    const deadline = Date.now() + 2000;
    while (s.requests.length < 2 && Date.now() < deadline) { await Bun.sleep(10); }
    expect(s.requests).toHaveLength(2);
    const excess = await s.send();
    expect(excess.status).toBe(503);
    expect(s.requests).toHaveLength(2);
    expect((await first).status).toBe(503);
    expect((await second).status).toBe(503);
    const next = await s.send();
    expect(next.status).toBe(503);
    expect(s.requests).toHaveLength(3);
  } finally { await s.close(); }
}, 15000);

for (const response of [() => new Response("x".repeat(65537)), () => Response.json({ partialSuccess: { rejectedLogRecords: "999999999999999999999" } }), () => Response.json({ partialSuccess: { rejectedLogRecords: "-1" } })]) {
  test("invalid collector receipt is bounded and never echoed", async () => {
    const s = setup(response);
    try { expect((await s.send()).status).toBe(500); expect(s.requests).toHaveLength(1); }
    finally { await s.close(); }
  });
}

test("missing exporter configuration is retryable", async () => {
  const app = createTestApp({ logging: { silent: true } });
  try { expect((await app.handler(post())).status).toBe(503); } finally { await app.dispose(); }
});
