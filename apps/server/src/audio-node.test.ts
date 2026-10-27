/* oxlint-disable no-await-in-loop -- The journey observes ordered WebSocket messages and cleans resources in reverse order. */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { NodeMessageSchema } from "@orbis/contracts/node";
import type { NodeMessage } from "@orbis/contracts/node";
import { Schema } from "effect";
import type { WideEvent } from "evlog";

import { startAudioNode } from "./audio-node.js";
import { configureLogging } from "./logging.js";
import type { LoggingOptions } from "./logging.js";

const decodeNodeMessage = Schema.decodeUnknownSync(NodeMessageSchema);

configureLogging({ silent: true });

const collect = () => {
  const events: WideEvent[] = [];
  const logging: LoggingOptions = {
    onEvent: (event) => {
      events.push(event);
    },
    silent: true,
  };
  const named = (name: string) =>
    events.filter((event) => event.event === name);
  const jobs = (name: string) => events.filter((event) => event.job === name);
  return { jobs, logging, named };
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});
const until = async (predicate: () => boolean) => {
  for (let attempt = 0; !predicate(); attempt += 1) {
    if (attempt >= 1000) {
      throw new Error("Timed out waiting for node");
    }
    await Bun.sleep(10);
  }
};

test("real node reconnects and handles duplicate download, details and release commands without a database", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orbis-node-"));
  cleanups.push(() => rm(directory, { force: true, recursive: true }));
  const fixture = path.join(directory, "fixture.mp3");
  const generated = Bun.spawn([
    "ffmpeg",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    fixture,
  ]);
  expect(await generated.exited).toBe(0);
  const runner = path.join(directory, "yt-dlp");
  await writeFile(
    runner,
    `#!/usr/bin/env python3\nimport sys, shutil, json\nif '--version' in sys.argv: print('fixture')\nelif '--dump-single-json' in sys.argv: print(json.dumps({'title':'Fixture', 'duration':1}))\nelif any('broken' in arg for arg in sys.argv): sys.exit('ERROR: fixture refused')\nelse: shutil.copyfile(${JSON.stringify(fixture)},sys.argv[sys.argv.index('-o')+1])\n`,
    { mode: 0o755 }
  );
  const { jobs, logging, named } = collect();
  const messages: NodeMessage[] = [];
  let socket: Bun.ServerWebSocket<undefined> | undefined;
  const server = Bun.serve({
    fetch(request, listener) {
      expect(request.headers.get("authorization")).toBe("Bearer node-secret");
      if (listener.upgrade(request)) {
        return;
      }
      return new Response(null, { status: 400 });
    },
    port: 0,
    websocket: {
      message(_ws, message) {
        messages.push(decodeNodeMessage(JSON.parse(String(message))));
      },
      open(ws) {
        socket = ws;
      },
    },
  });
  cleanups.push(async () => {
    await server.stop(true);
  });
  const node = await startAudioNode({
    audioDir: path.join(directory, "audio"),
    groupUrl: `ws://localhost:${server.port}/api/node`,
    logging,
    nodeKey: "node-secret",
    reconnectDelayMs: 10,
    ytdlpBin: runner,
  });
  cleanups.push(() => node.close());
  await until(() => messages.some((message) => message.kind === "inventory"));
  expect(named("node-link-connected")).toMatchObject([
    { files: 0, level: "info" },
  ]);
  const start = {
    kind: "start",
    requestId: "run1",
    setId: "fixture",
    source: "youtube",
    url: "https://youtu.be/abcdefghijk",
  };
  socket?.send(JSON.stringify(start));
  socket?.send(JSON.stringify(start));
  await until(() => messages.some((message) => message.kind === "finished"));
  expect(messages.find((message) => message.kind === "finished")).toMatchObject(
    { format: "mp3", requestId: "run1", setId: "fixture" }
  );
  socket?.send(
    JSON.stringify({
      ...start,
      requestId: "run2",
      setId: "broken",
      url: "https://youtu.be/broken00000",
    })
  );
  await until(() => messages.some((message) => message.kind === "failed"));
  await until(() => jobs("audio-download").length === 2);
  expect(jobs("audio-download")).toMatchObject([
    {
      attempts: [{ backend: "ytdlp", ok: true }],
      backend: "ytdlp",
      level: "info",
      outcome: "success",
      requestId: "run1",
      set: "fixture",
      source: "youtube",
    },
    {
      attempts: [{ backend: "ytdlp", ok: false }],
      level: "error",
      outcome: "failure",
      requestId: "run2",
      set: "broken",
    },
  ]);
  expect(JSON.stringify(jobs("audio-download")[1])).toContain(
    "fixture refused"
  );
  socket?.send(
    JSON.stringify({
      kind: "read-details",
      requestId: "details1",
      setId: "fixture",
      url: start.url,
    })
  );
  await until(() => messages.some((message) => message.kind === "details"));
  socket?.close(4000, "fixture closed");
  await until(
    () =>
      messages.filter((message) => message.kind === "inventory").length === 2
  );
  expect(named("node-link-closed")).toMatchObject([
    {
      code: 4000,
      heartbeatTimedOut: false,
      level: "warn",
      reason: "fixture closed",
    },
  ]);
  expect(named("node-link-reconnecting")).toMatchObject([
    { attempt: 1, delayMs: 10, level: "info" },
  ]);
  expect(named("node-link-connected")).toMatchObject([
    { files: 0 },
    { files: 1 },
  ]);
  expect(
    messages.filter((message) => message.kind === "inventory")[1]
  ).toMatchObject({ files: [{ format: "mp3", setId: "fixture" }] });
  socket?.send(
    JSON.stringify({ kind: "release", requestId: "release1", setId: "fixture" })
  );
  await until(() => messages.some((message) => message.kind === "released"));
  expect(await readdir(path.join(directory, "audio"))).toEqual([]);
  const names = await readdir(directory);
  expect(names.some((name) => /sqlite|devices/u.test(name))).toBe(false);
});

test("node reconnects when the Group stops answering heartbeats", async () => {
  const { logging, named } = collect();
  const directory = await mkdtemp(path.join(os.tmpdir(), "orbis-node-"));
  cleanups.push(() => rm(directory, { force: true, recursive: true }));
  const messages: NodeMessage[] = [];
  let answering = true;
  const server = Bun.serve({
    fetch(request, listener) {
      if (listener.upgrade(request)) {
        return;
      }
      return new Response(null, { status: 400 });
    },
    port: 0,
    websocket: {
      message(ws, message) {
        if (message === "ping") {
          if (answering) {
            ws.send("pong");
          }
          return;
        }
        messages.push(decodeNodeMessage(JSON.parse(String(message))));
      },
    },
  });
  cleanups.push(async () => {
    await server.stop(true);
  });
  const node = await startAudioNode({
    audioDir: path.join(directory, "audio"),
    groupUrl: `ws://localhost:${server.port}/api/node`,
    heartbeatMs: 50,
    logging,
    nodeKey: "node-secret",
    reconnectDelayMs: 10,
  });
  cleanups.push(() => node.close());
  await until(() => messages.some((message) => message.kind === "inventory"));
  await Bun.sleep(300);
  expect(
    messages.filter((message) => message.kind === "inventory")
  ).toHaveLength(1);
  answering = false;
  await until(
    () =>
      messages.filter((message) => message.kind === "inventory").length === 2
  );
  expect(named("node-link-closed")).toMatchObject([
    { heartbeatTimedOut: true, level: "warn" },
  ]);
  await server.stop(true);
  await until(() =>
    named("node-link-reconnecting").some((event) => event.level === "error")
  );
  expect(
    named("node-link-reconnecting").find((event) => event.level === "error")
  ).toMatchObject({
    attempt: 5,
    connectFailed: expect.stringMatching(/^1006\b/u),
  });
});
