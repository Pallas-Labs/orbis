import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Schema } from "effect";

import { everystate } from "./models.js";
import { createTestApp as createApp } from "./test-app.js";
import { idIn, request } from "./test-http.js";
import type { TestResponse } from "./test-http.js";

// Ways the recorded run could pass `everystate conform` while the server breaks the spec:
// - the server value in a line comes from what the test sent, not from the server's answer, so
//   a server that keeps the wrong save still conforms;
// - a stored value is rounded into a model position, so a server that stores a nearby value
//   still matches (each value must be an exact multiple of the interval);
// - every save goes forward, so a server that keeps the largest save looks the same as one that
//   keeps the last (the run sends a save that goes back);
// - the client steps (Listen, Pause, Report, Answer) are scripted by this test, not by the Apple
//   or web client, so the trace checks the server's answers, not the clients;
// - a resume reads `GET /sets/:id`, and the Apple client reads the Listening Queue; both build
//   the Set with the same stored position, but this test reads only the first;
// - conform accepts any trace, so a pass proves nothing (the tampered trace must fail with 20).
const artifactDirectory = path.resolve(
  import.meta.dir,
  "../../../.cache/everystate"
);
const youTubeUrl = "https://www.youtube.com/watch?v=aqzKEbpKQAA";
/** One model position is one report interval. */
const interval = 10;

type Device = "phone" | "mac";

/** One device's value of a per-device variable; `"..."` leaves the other device's open. */
type OneDevice = Readonly<Partial<Record<Device | "...", number>>>;

/** One line of an `everystate conform` trace against `PlaybackPosition.tla`. */
interface Observation {
  readonly action?: string;
  readonly params?: readonly [Device];
  readonly state?: {
    readonly known?: OneDevice;
    readonly local?: OneDevice;
    readonly server?: number;
    readonly writer?: Device | "nobody";
  };
}

const decodePosition = Schema.decodeUnknownSync(
  Schema.Struct({ playbackPositionSeconds: Schema.Finite })
);

/** The stored position a response carried, as a model position. */
const positionIn = (response: TestResponse) => {
  const seconds = decodePosition(response.json()).playbackPositionSeconds;
  expect(seconds % interval).toBe(0);
  return seconds / interval;
};

test("two devices' saves conform to PlaybackPosition.tla", async () => {
  const app = createApp({ logging: { silent: true } });
  try {
    const saved = await request(app, {
      method: "POST",
      payload: { tags: [], title: "Traced set", url: youTubeUrl },
      url: "/sets",
    });
    const id = idIn(saved);

    // Each device as the clients keep it: the player, the report in flight, the answer on its
    // way, and the stored position it last heard (savedPosition).
    const devices = {
      mac: { known: 0, local: 0, outbox: 0, reply: 0 },
      phone: { known: 0, local: 0, outbox: 0, reply: 0 },
    };
    const observations: Observation[] = [
      { state: { server: 0, writer: "nobody" } },
    ];
    const log = (
      action: string,
      device: Device,
      state?: Observation["state"]
    ) => {
      observations.push(
        state === undefined
          ? { action, params: [device] }
          : { action, params: [device], state }
      );
    };

    const listen = (device: Device) => {
      devices[device].local += 1;
      log("Listen", device);
    };
    const pause = (device: Device) => {
      log("Pause", device);
    };
    const report = (device: Device) => {
      devices[device].outbox = devices[device].local;
      log("Report", device);
    };
    // Library.setPlaybackPosition stores the report and answers with what it stored.
    const save = async (device: Device) => {
      const response = await request(app, {
        method: "PUT",
        payload: { seconds: devices[device].outbox * interval },
        url: `/sets/${id}/position`,
      });
      expect(response.statusCode).toBe(200);
      const server = positionIn(response);
      devices[device].reply = server;
      log("Save", device, { server, writer: device });
    };
    const answer = (device: Device) => {
      devices[device].known = devices[device].reply;
      log("Answer", device, {
        known: { [device]: devices[device].known, "...": 0 },
      });
    };
    // newerSavedPosition: move to the stored position only when it differs from the known one.
    const resume = async (device: Device) => {
      const response = await request(app, {
        method: "GET",
        url: `/sets/${id}`,
      });
      expect(response.statusCode).toBe(200);
      const server = positionIn(response);
      const state = devices[device];
      if (server !== state.known) {
        state.local = server;
        state.known = server;
      }
      log("Resume", device, {
        local: { [device]: state.local, "...": 0 },
        server,
      });
    };

    await resume("mac");
    await resume("phone");
    listen("phone");
    listen("phone");
    listen("mac");
    // Both reports are in flight; the phone's lands last, so the server holds 2.
    report("phone");
    report("mac");
    await save("mac");
    await save("phone");
    answer("mac");
    answer("phone");
    // The mac pauses at 1. Its save goes back from 2, and the server keeps it: the last save
    // wins, not the largest.
    pause("mac");
    report("mac");
    await save("mac");
    answer("mac");
    pause("phone");
    report("phone");
    await save("phone");
    answer("phone");
    // Handoff: the mac last heard 1, the server holds the phone's pause at 2, so it moves there.
    await resume("mac");

    expect(observations.map((each) => each.action ?? "start")).toEqual([
      "start",
      "Resume",
      "Resume",
      "Listen",
      "Listen",
      "Listen",
      "Report",
      "Report",
      "Save",
      "Save",
      "Answer",
      "Answer",
      "Pause",
      "Report",
      "Save",
      "Answer",
      "Pause",
      "Report",
      "Save",
      "Answer",
      "Resume",
    ]);

    await mkdir(artifactDirectory, { recursive: true });
    const conform = async (name: string, lines: readonly Observation[]) => {
      const trace = path.join(artifactDirectory, `${name}.jsonl`);
      await writeFile(
        trace,
        `${lines.map((each) => JSON.stringify(each)).join("\n")}\n`
      );
      // Every step is logged, so no step may go unlogged (no -hidden).
      const run = everystate([
        "conform",
        "-config",
        "PlaybackPositionTrace.cfg",
        "-trace",
        trace,
        "PlaybackPosition.tla",
      ]);
      await writeFile(
        path.join(artifactDirectory, `${name}.conform.txt`),
        run.output
      );
      return run;
    };

    const real = await conform("playback-position", observations);
    expect(real.output).toContain("Trace conforms");
    expect(real.exitCode).toBe(0);
    expect(devices.mac.local).toBe(2);

    // The mac's pause save, the one that goes back from 2 to 1.
    const pauseSave = observations.findIndex(
      (each, index) =>
        each.action === "Save" && observations[index - 2]?.action === "Pause"
    );
    expect(observations[pauseSave]).toEqual({
      action: "Save",
      params: ["mac"],
      state: { server: 1, writer: "mac" },
    });

    // The same run without that save is not a behaviour of the spec: the mac's next Answer
    // has no save to answer.
    const tampered = await conform(
      "playback-position-tampered",
      observations.filter((_each, index) => index !== pauseSave)
    );
    expect(tampered.exitCode).toBe(20);

    // A server that kept the largest save would answer 2 there. The spec refuses that run too,
    // so the trace tells the last save from the largest.
    const largest = await conform(
      "playback-position-largest",
      observations.map((each, index) =>
        index === pauseSave
          ? { ...each, state: { server: 2, writer: "mac" } }
          : each
      )
    );
    expect(largest.exitCode).toBe(20);
  } finally {
    await app.dispose();
  }
});
