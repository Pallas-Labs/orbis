import { expect, setSystemTime, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Schema } from "effect";
import type { WideEvent } from "evlog";

import { makeNodeAudioHandler } from "./node-audio-http.js";
import { listen } from "./node-listener.js";
import { grantSecret, issueStreamGrant } from "./stream-grant.js";
import { transcript, waitUntil } from "./test-http.js";

const LONG_AGO_MS = Date.UTC(2020, 0, 1);
const FAR_FUTURE_MS = Date.UTC(2100, 0, 1);

/** A grant signed with the right secret but issued at another time. */
const grantIssuedAt = (secret: Buffer, setId: string, at: number) => {
  setSystemTime(new Date(at));
  try {
    return issueStreamGrant(secret, setId, "host");
  } finally {
    setSystemTime();
  }
};

/** What a body that the client read to its end records. */
const delivered = (sent: number) => ({
  aborted: false,
  lastByteMs: expect.any(Number),
  sent,
});

const decodeDelivery = Schema.decodeUnknownSync(
  Schema.Struct({
    aborted: Schema.Boolean,
    bytes: Schema.Int,
    lastByteMs: Schema.Int,
    sent: Schema.Int,
  })
);
/** The body-finish fields of a logged request, parsed rather than assumed. */
const deliveryOf = (event: WideEvent | undefined) =>
  decodeDelivery(event?.audio);

test("the audio node records one wide event per request, with the grant verdict and never the grant", async () => {
  const audioDir = await mkdtemp(path.join(tmpdir(), "orbis-node-events-"));
  const fixture = path.resolve(
    import.meta.dir,
    "../../../scripts/fixtures/ready-set.m4a"
  );
  await copyFile(fixture, path.join(audioDir, "fixture.m4a"));
  const { size } = Bun.file(fixture);
  const streamSecret = grantSecret(path.join(audioDir, "stream-grant.key"));
  const grant = issueStreamGrant(streamSecret, "fixture", "host");
  const expired = grantIssuedAt(streamSecret, "fixture", LONG_AGO_MS);
  const ahead = grantIssuedAt(streamSecret, "fixture", FAR_FUTURE_MS);
  const events: WideEvent[] = [];
  const audio = makeNodeAudioHandler({
    audioDir,
    logging: {
      onEvent: (event) => {
        events.push(event);
      },
      silent: true,
    },
    streamSecret,
  });
  const refusalBytes = JSON.stringify({
    message: "Invalid stream grant.",
  }).length;
  const send = async (target: string, init?: RequestInit) => {
    const response = await audio(new Request(`http://node${target}`, init));
    await response.arrayBuffer();
    return response.status;
  };
  try {
    const statuses = [
      await send(`/api/sets/fixture/audio?grant=${grant}`),
      await send(`/api/sets/fixture/audio?grant=${grant}`, {
        headers: { range: "bytes=7-22" },
      }),
      await send(`/sets/fixture/audio?grant=${grant}`, {
        headers: { range: `bytes=${size}-` },
      }),
      await send(
        `/sets/absent/audio?grant=${issueStreamGrant(streamSecret, "absent", "host")}`
      ),
      await send("/sets/fixture/audio"),
      await send("/sets/fixture/audio?grant=altered"),
      await send(`/sets/another/audio?grant=${grant}`),
      await send(`/sets/fixture/audio?grant=${expired}`),
      await send(`/sets/fixture/audio?grant=${ahead}`),
    ];
    expect(statuses).toEqual([200, 206, 416, 404, 401, 401, 401, 401, 401]);
    expect(events.map((event) => event.ingress)).toEqual(
      statuses.map(() => "funnel-audio")
    );
    expect(events.map((event) => event.status)).toEqual(statuses);
    expect(events.map((event) => event.audio)).toEqual([
      {
        ...delivered(size),
        bytes: size,
        file: "found",
        format: "m4a",
        grant: "valid",
        person: "host",
        set: "fixture",
        size,
      },
      {
        ...delivered(16),
        bytes: 16,
        file: "found",
        format: "m4a",
        grant: "valid",
        person: "host",
        range: "bytes=7-22",
        set: "fixture",
        size,
      },
      {
        file: "found",
        format: "m4a",
        grant: "valid",
        person: "host",
        range: `bytes=${size}-`,
        set: "fixture",
        size,
      },
      {
        ...delivered(
          JSON.stringify({ message: "This Set has no audio yet." }).length
        ),
        file: "missing",
        grant: "valid",
        person: "host",
        set: "absent",
      },
      { ...delivered(refusalBytes), grant: "missing", set: "fixture" },
      { ...delivered(refusalBytes), grant: "malformed", set: "fixture" },
      { ...delivered(refusalBytes), grant: "bad-signature", set: "another" },
      { ...delivered(refusalBytes), grant: "expired", set: "fixture" },
      { ...delivered(refusalBytes), grant: "future-expiry", set: "fixture" },
    ]);
    expect(events.every((event) => event.duration !== undefined)).toBe(true);
    const logged = JSON.stringify(events);
    for (const secret of [grant, expired, ahead, "altered"]) {
      expect(logged).not.toContain(secret);
    }
  } finally {
    await rm(audioDir, { force: true, recursive: true });
  }
});

test("the audio node checks grants before keys and serves full, ranged, and HEAD audio", async () => {
  const audioDir = await mkdtemp(path.join(tmpdir(), "orbis-node-audio-"));
  const fixture = path.resolve(
    import.meta.dir,
    "../../../scripts/fixtures/ready-set.m4a"
  );
  await copyFile(fixture, path.join(audioDir, "fixture.m4a"));
  const streamSecret = grantSecret(path.join(audioDir, "stream-grant.key"));
  const grant = issueStreamGrant(streamSecret, "fixture", "host");
  const server = await listen(
    makeNodeAudioHandler({ audioDir, streamSecret }),
    {
      hostname: "127.0.0.1",
      port: 0,
    }
  );
  const url = new URL(`/sets/fixture/audio?grant=${grant}`, server.url);
  try {
    const full = await fetch(url);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("audio/mp4");
    const bytes = new Uint8Array(await full.arrayBuffer());
    expect(bytes.length).toBe(Bun.file(fixture).size);
    const range = await fetch(url, { headers: { range: "bytes=7-22" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe(
      `bytes 7-22/${bytes.length}`
    );
    expect(range.headers.get("content-length")).toBe("16");
    expect(range.headers.get("transfer-encoding")).toBeNull();
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(
      bytes.slice(7, 23)
    );
    const suffix = await fetch(url, { headers: { range: "bytes=-16" } });
    expect(suffix.status).toBe(206);
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(
      bytes.slice(-16)
    );
    const head = await fetch(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(Number(head.headers.get("content-length"))).toBe(bytes.length);
    expect(await head.text()).toBe("");
    const beyond = await fetch(url, {
      headers: { range: `bytes=${bytes.length}-` },
    });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toBe(`bytes */${bytes.length}`);
    await beyond.text();
    const withKey = await fetch(url, {
      headers: { authorization: "Bearer invalid" },
    });
    expect(withKey.status).toBe(200);
    await withKey.arrayBuffer();
    const rejected = await Promise.all([
      fetch(new URL("/sets/fixture/audio", server.url), {
        headers: { authorization: "Bearer valid-looking" },
      }),
      fetch(new URL("/sets/fixture/audio?grant=altered", server.url)),
      fetch(new URL(`/sets/another/audio?grant=${grant}`, server.url)),
      fetch(
        new URL(
          `/sets/fixture/audio?grant=${grant.replace(/^\d+/u, "1000000000000")}`,
          server.url
        )
      ),
      fetch(new URL("/sets/fixture/audio?grant=invalid", server.url), {
        headers: { authorization: "Bearer valid-looking" },
      }),
    ]);
    expect(rejected.map((response) => response.status)).toEqual([
      401, 401, 401, 401, 401,
    ]);
    await Promise.all(rejected.map((response) => response.text()));
    const nongrant = await fetch(new URL("/health", server.url));
    expect(nongrant.status).toBe(404);
    await nongrant.text();
  } finally {
    await server.stop();
    await rm(audioDir, { force: true, recursive: true });
  }
});

test("the audio node logs when each body left it, and how much, including a client that leaves mid-body", async () => {
  const audioDir = await mkdtemp(path.join(tmpdir(), "orbis-node-delivery-"));
  // Larger than the socket buffers on both ends, so a client that stops reading holds the
  // node back and the node sees it leave before the body is done.
  const size = 32 * 1024 * 1024;
  const skipped = 1024 * 1024;
  await Bun.write(path.join(audioDir, "long.m4a"), new Uint8Array(size));
  const streamSecret = grantSecret(path.join(audioDir, "stream-grant.key"));
  const grant = issueStreamGrant(streamSecret, "long", "host");
  const events: WideEvent[] = [];
  const server = await listen(
    makeNodeAudioHandler({
      audioDir,
      logging: {
        onEvent: (event) => {
          events.push(event);
        },
        silent: true,
      },
      streamSecret,
    }),
    { hostname: "127.0.0.1", port: 0 }
  );
  const url = new URL(`/sets/long/audio?grant=${grant}`, server.url);
  const flow = transcript();
  const logged = async (count: number) => {
    await waitUntil(() => events.length >= count, {
      message: "The node did not log the request",
    });
    const event = events[count - 1];
    const { aborted, bytes, lastByteMs, sent } = deliveryOf(event);
    let share = "fewer than the range";
    if (sent === bytes) {
      share = "the whole range";
    } else if (sent > bytes) {
      share = "more than the range";
    }
    return `log ${String(event?.status)} ${String(event?.outcome)}, aborted ${String(aborted)}, sent ${share}, lastByteMs ${lastByteMs >= 0 ? "set" : "missing"}`;
  };
  try {
    const whole = await fetch(url, {
      headers: { range: `bytes=${String(skipped)}-${String(size - 1)}` },
    });
    const body = await whole.arrayBuffer();
    const received = body.byteLength;
    flow.step(
      "GET a 31 MiB range and read it all",
      `${String(whole.status)}, content-length ${String(whole.headers.get("content-length"))}, read ${String(received)}; ${await logged(1)}`
    );
    const partial = await fetch(url, { headers: { range: "bytes=0-" } });
    const reader = partial.body?.getReader();
    const first = await reader?.read();
    await reader?.cancel();
    flow.step(
      "GET the whole file, read one chunk, then leave",
      `${String(partial.status)}, read ${first?.done === false ? "one chunk" : "nothing"}; ${await logged(2)}`
    );
    expect(flow.text()).toMatchInlineSnapshot(`
      "
      GET a 31 MiB range and read it all  -> 206, content-length 32505856, read 32505856; log 206 success, aborted false, sent the whole range, lastByteMs set
      GET the whole file, read one chunk, then leave  -> 206, read one chunk; log 206 cancelled, aborted true, sent fewer than the range, lastByteMs set
      "
    `);
    expect(events.map((event) => event.ingress)).toEqual([
      "funnel-audio",
      "funnel-audio",
    ]);
    expect(deliveryOf(events[0]).sent).toBe(size - skipped);
    expect(deliveryOf(events[1]).sent).toBeLessThan(size);
  } finally {
    await server.stop();
    await rm(audioDir, { force: true, recursive: true });
  }
});
