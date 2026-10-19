import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Miniflare } from "miniflare";

import fixture from "../../server/src/fixtures/playback-upload.json";

const artifact = path.resolve(
  import.meta.dir,
  "../../../.cache/api-playback",
  crypto.randomUUID()
);
await mkdir(artifact, { recursive: true });
const requests: unknown[] = [];
const collector = Bun.serve({
  fetch: async (request) => {
    assert.equal(request.headers.get("user-agent"), "Orbis-Playback-Relay/1");
    assert.equal(request.headers.get("cf-access-client-id"), "fixture-id");
    assert.equal(
      request.headers.get("cf-access-client-secret"),
      "fixture-secret"
    );
    requests.push(await request.json());
    return Response.json({});
  },
  hostname: "127.0.0.1",
  port: 0,
});
const bundle = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "worker.ts")],
  external: ["cloudflare:workers", "node:*"],
  target: "browser",
});
assert.equal(bundle.success, true, String(bundle.logs));
const [output] = bundle.outputs;
assert.ok(output);
const runtime = new Miniflare({
  bindings: {
    AUDIO_NODE_URL: "https://audio.example",
    SIGNOZ_OTLP_ACCESS_CLIENT_ID: "fixture-id",
    SIGNOZ_OTLP_ACCESS_CLIENT_SECRET: "fixture-secret",
    SIGNOZ_OTLP_URL: collector.url.toString(),
    STREAM_GRANT_SECRET: "ab".repeat(32),
  },
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { GROUP: { className: "Group", useSQLite: true } },
  durableObjectsPersist: path.join(artifact, "storage"),
  modules: true,
  script: await output.text(),
});
try {
  const seeded = await runtime.dispatchFetch("http://orbis/api/__seed");
  assert.equal(seeded.status, 200);
  const send = (body: BodyInit) =>
    runtime.dispatchFetch("http://orbis/api/diagnostics/playback", {
      body,
      headers: {
        authorization: "Bearer smoke-token",
        "content-type": "application/json",
      },
      method: "POST",
    });
  const valid = await send(JSON.stringify(fixture));
  assert.equal(valid.status, 200, await valid.clone().text());
  assert.deepEqual(await valid.json(), {
    accepted: fixture.entries.length,
    rejected: 0,
  });
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(8192).fill(32));
    },
  });
  const oversized = await send(stream);
  assert.equal(oversized.status, 413, await oversized.clone().text());
  assert.equal(requests.length, 1);
  await writeFile(
    path.join(artifact, "otlp.json"),
    JSON.stringify(requests, null, 2)
  );
  await writeFile(
    path.join(artifact, "result.json"),
    JSON.stringify({
      chunked: oversized.status,
      collectorRequests: requests.length,
      valid: valid.status,
    })
  );
  process.stdout.write(`Playback Group passed: ${artifact}\n`);
} finally {
  await runtime.dispose();
  await collector.stop(true);
}
