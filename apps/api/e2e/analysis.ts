import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SaveSetInput, SetAnalysis } from "@orbis/contracts";
import { SavedSetSchema, SetPageSchema } from "@orbis/contracts/http-api";
import type { NodeMessage } from "@orbis/contracts/node";
import { Schema } from "effect";
import { Miniflare } from "miniflare";

import { eventStream, pollUntil } from "../../server/src/test-http.js";
import { workerModules } from "./worker-modules.js";

// The Rinse FM Set's analysis, cut down: its five sections and a few windows of each curve.
const ANALYSIS: SetAnalysis = {
  bpmCurve: [
    { bpm: 140, seconds: 90 },
    { bpm: 143, seconds: 6060 },
    { bpm: 160, seconds: 6300 },
    { bpm: 145, seconds: 6720 },
    { bpm: 130, seconds: 7110 },
  ],
  durationSeconds: 7206.1,
  integratedLufs: -13.5,
  loudnessCurve: [
    { lufs: -20.3, seconds: 0 },
    { lufs: -12.1, seconds: 30 },
    { lufs: -14.7, seconds: 6300 },
  ],
  medianBpm: 140,
  sections: [
    { bpm: 140, endSeconds: 6045, name: "Locked in", startSeconds: 0 },
    { bpm: 143, endSeconds: 6255, name: "Lift", startSeconds: 6045 },
    { bpm: 160, endSeconds: 6675, name: "Peak", startSeconds: 6255 },
    { bpm: 145, endSeconds: 7095, name: "Come down", startSeconds: 6675 },
    { bpm: 130, endSeconds: 7206.1, name: "Close", startSeconds: 7095 },
  ],
};

const decodeSavedSet = Schema.decodeUnknownSync(SavedSetSchema);
const decodeSetPage = Schema.decodeUnknownSync(SetPageSchema);
const GroupEvent = Schema.Struct({
  event: Schema.String,
  outcome: Schema.optional(Schema.String),
  set: Schema.optional(Schema.String),
});
const decodeGroupEvent = Schema.decodeUnknownSync(GroupEvent);

const artifact = path.resolve(
  import.meta.dir,
  "../../../.cache/api-analysis",
  crypto.randomUUID()
);
await mkdir(artifact, { recursive: true });
const bundle = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "node-worker.ts")],
  external: ["cloudflare:workers", "node:*"],
  target: "browser",
});
assert.equal(bundle.success, true, String(bundle.logs));
const [output] = bundle.outputs;
assert.ok(output !== undefined);
const groupLog: string[] = [];
const runtime = new Miniflare({
  bindings: {
    AUDIO_NODE_URL: "https://audio.example",
    STREAM_GRANT_SECRET: "ab".repeat(32),
  },
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { GROUP: { className: "Group", useSQLite: true } },
  durableObjectsPersist: path.join(artifact, "storage"),
  handleStructuredLogs: ({ message }: { message: string }) => {
    groupLog.push(message);
  },
  modules: workerModules(await output.text()),
});
/** Each step as one `request -> answer` line, written to the artifact. */
const steps: string[] = [];
const call = async (
  route: string,
  method = "GET",
  body?: SaveSetInput,
  token = "client-token"
) => {
  const response = await runtime.dispatchFetch(`http://orbis/api${route}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method,
  });
  return response;
};
const groupEvents = (name: string) =>
  groupLog
    .flatMap((text) => text.split("\n"))
    .filter((line) => line.includes(`"event":"${name}"`))
    .map((line) => decodeGroupEvent(JSON.parse(line)));
const readPage = async (id: string) => {
  const response = await call(`/sets/${id}`);
  assert.equal(response.status, 200, await response.clone().text());
  return decodeSetPage(await response.json());
};
try {
  const seeded = await call("/__seed-node");
  assert.equal(seeded.status, 200);
  const linked = await runtime.dispatchFetch("http://orbis/api/node", {
    headers: { Upgrade: "websocket", authorization: "Bearer node-token" },
  });
  assert.equal(linked.status, 101, await linked.text());
  const socket = linked.webSocket;
  assert.ok(socket);
  socket.accept();
  const send = (message: NodeMessage) => {
    socket.send(JSON.stringify(message));
  };
  send({ files: [], kind: "inventory" });

  const saved = await call("/sets", "POST", {
    tags: [],
    title: "Stay On Sight",
    url: "https://soundcloud.com/fixture/stay-on-sight",
  });
  assert.equal(saved.status, 201, await saved.clone().text());
  const set = decodeSavedSet(await saved.json());
  steps.push(`POST /sets  -> 201 ${set.id}`);

  const before = await readPage(set.id);
  assert.equal(before.analysis, null);
  assert.equal(before.id, set.id);
  assert.equal(before.title, set.title);
  steps.push(`GET /sets/${set.id}  -> 200 analysis: null`);

  const missing = await call("/sets/no-such-set");
  assert.equal(missing.status, 404);
  steps.push("GET /sets/no-such-set  -> 404");

  const events = await call("/events?changes=1");
  assert.equal(events.status, 200);
  const stream = eventStream(events);
  // The first frame is the Queue; it says the stream is open before the analysis goes.
  assert.match((await stream.next()) ?? "", /"kind":"queue"/u);
  /** The next `changed` frame, past heartbeats and presence. */
  const nextChange = async (): Promise<string> => {
    const frame = await stream.next();
    assert.ok(frame !== null, "the events stream ended");
    return frame.includes('"kind":"changed"') ? frame : await nextChange();
  };
  const changed = nextChange();

  send({ analysis: ANALYSIS, kind: "analysis", setId: set.id });
  steps.push(`node: analysis ${set.id} (${ANALYSIS.sections.length} sections)`);
  const changeLine = await changed;
  assert.match(changeLine, /"topic":"set"/u);
  steps.push(`GET /events?changes=1  -> ${changeLine}`);

  const after = await pollUntil(
    async () => {
      const page = await readPage(set.id);
      return page.analysis === null ? null : page;
    },
    { interval: 50 }
  );
  assert.deepEqual(after.analysis, ANALYSIS);
  steps.push(
    `GET /sets/${set.id}  -> 200 analysis: median ${after.analysis?.medianBpm} BPM, ${after.analysis?.integratedLufs} LUFS, ${after.analysis?.sections.map((section) => section.name).join(", ")}`
  );

  // A newer analysis replaces the stored one.
  const remeasured = { ...ANALYSIS, medianBpm: 140.1 };
  send({ analysis: remeasured, kind: "analysis", setId: set.id });
  const replaced = await pollUntil(
    async () => {
      const page = await readPage(set.id);
      return page.analysis?.medianBpm === 140.1 ? page : null;
    },
    { interval: 50 }
  );
  assert.deepEqual(replaced.analysis, remeasured);
  steps.push(
    `node: analysis ${set.id} again  -> GET /sets/${set.id} median 140.1 BPM`
  );

  // Each connect sends every stored analysis again; an unchanged one writes and announces nothing.
  send({ analysis: remeasured, kind: "analysis", setId: set.id });
  const repeated = await pollUntil(
    () =>
      Promise.resolve(
        groupEvents("group-analysis-received").find(
          (event) => event.set === set.id && event.outcome === "unchanged"
        )
      ),
    { interval: 50 }
  );
  steps.push(
    `node: same analysis ${set.id}  -> group-analysis-received outcome: ${repeated.outcome}`
  );

  // The node keeps files for Sets the Group no longer knows; their analyses are not stored.
  send({ analysis: ANALYSIS, kind: "analysis", setId: "forgotten-set" });
  const unknown = await pollUntil(
    () =>
      Promise.resolve(
        groupEvents("group-analysis-received").find(
          (event) => event.set === "forgotten-set"
        )
      ),
    { interval: 50 }
  );
  assert.equal(unknown.outcome, "unknown-set");
  steps.push(
    "node: analysis forgotten-set  -> group-analysis-received outcome: unknown-set"
  );

  // A malformed analysis closes the link, as any invalid node message does.
  let closeCode: number | undefined;
  socket.addEventListener("close", (event) => {
    closeCode = event.code;
  });
  socket.send(
    JSON.stringify({
      analysis: { ...ANALYSIS, bpmCurve: "fast" },
      kind: "analysis",
      setId: set.id,
    })
  );
  const code = await pollUntil(() => Promise.resolve(closeCode), {
    interval: 20,
  });
  assert.equal(code, 1008);
  steps.push(`node: malformed analysis  -> link closed ${code}`);
  const kept = await readPage(set.id);
  assert.deepEqual(kept.analysis, remeasured);
  await stream.close();

  const transcript = `${steps.join("\n")}\n`;
  await writeFile(path.join(artifact, "transcript.txt"), transcript);
  await writeFile(
    path.join(artifact, "result.json"),
    `${JSON.stringify({ analysis: replaced.analysis, set: set.id, steps }, null, 2)}\n`
  );
  console.log(transcript);
  console.log(`Analysis journey passed. ${path.join(artifact, "result.json")}`);
} finally {
  await runtime.dispose();
}
