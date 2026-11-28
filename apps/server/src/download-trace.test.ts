import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ObservedMove } from "./download-state.js";
import { everystate } from "./models.js";
import { createTestApp as createApp } from "./test-app.js";
import { idIn, request } from "./test-http.js";

// Ways the recorded run could pass `everystate conform` while the code breaks the spec:
// - a move that changes no row is still logged, so a no-op looks like a step;
// - moves of another Set land in the trace;
// - the observer misses moves made on the worker's fiber, so only HTTP moves are checked;
// - the trace is read after the wrong number of moves, so it stops short;
// - conform accepts any trace, so a pass proves nothing (the tampered trace must fail).
const artifactDirectory = path.resolve(
  import.meta.dir,
  "../../../.cache/everystate"
);
const youTubeUrl = "https://www.youtube.com/watch?v=aqzKEbpKQAA";

/** One line of an `everystate conform` trace: an action and the variables the code knows. */
interface Observation {
  readonly action?: string;
  readonly state: {
    readonly kept?: boolean;
    readonly state: string;
    readonly stored?: boolean;
  };
}

/** Records each move and resolves a wait when the awaited move has happened. */
const recorder = () => {
  const moves: ObservedMove[] = [];
  const waits: {
    readonly done: () => boolean;
    readonly resolve: (done: true) => void;
  }[] = [];
  const settle = () => {
    for (const wait of waits.filter((each) => each.done())) {
      waits.splice(waits.indexOf(wait), 1);
      wait.resolve(true);
    }
  };
  return {
    moves,
    observe: (move: ObservedMove) => {
      moves.push(move);
      settle();
    },
    /** Resolves once `move` has happened `times` times. */
    until: (move: ObservedMove["move"], times = 1) => {
      const { promise, resolve } = Promise.withResolvers<true>();
      waits.push({
        done: () => moves.filter((each) => each.move === move).length >= times,
        resolve,
      });
      settle();
      return promise;
    },
  };
};

const sineMp3 = async (folder: string) => {
  const file = path.join(folder, "sine.mp3");
  const ffmpeg = Bun.spawnSync([
    "ffmpeg",
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "128k",
    file,
  ]);
  expect(ffmpeg.exitCode).toBe(0);
  return new Uint8Array(await Bun.file(file).arrayBuffer());
};

test("a real Download's moves conform to SetDownload.tla", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbis-trace-"));
  const mp3 = await sineMp3(root);
  await writeFile(
    path.join(root, "devices.json"),
    JSON.stringify({
      keys: [],
      people: [
        { autoDownload: false, id: "host", removed: false, username: "host" },
      ],
      version: 2,
    })
  );
  const record = recorder();
  let cobaltCalls = 0;
  const app = createApp({
    audio: {
      audioDir: path.join(root, "audio"),
      cobaltApiKey: "test-key",
      cobaltUrl: "http://cobalt.test/",
      // The first fetch fails at Cobalt; the retry gets the mp3 through a tunnel.
      fetch: (target) => {
        if (target.startsWith("http://cobalt.test/")) {
          cobaltCalls += 1;
          return Promise.resolve(
            cobaltCalls === 1
              ? Response.json({ error: "fetch.fail", status: "error" })
              : Response.json({ status: "tunnel", url: "http://cdn.test/a" })
          );
        }
        return Promise.resolve(
          new Response(new Uint8Array(mp3), {
            headers: { "content-length": String(mp3.length) },
          })
        );
      },
      startWorker: true,
    },
    databasePath: path.join(root, "library.sqlite"),
    logging: { silent: true },
    observeDownloadMoves: record.observe,
  });
  try {
    const saved = await request(app, {
      method: "POST",
      payload: { tags: [], title: "Traced set", url: youTubeUrl },
      url: "/sets",
    });
    const id = idIn(saved);
    const download = () =>
      request(app, { method: "POST", url: `/sets/${id}/audio/download` });

    // Queue, Claim, then Fail: Cobalt refuses the first fetch.
    const first = await download();
    expect(first.statusCode).toBe(202);
    await record.until("Fail");
    // A retry: Queue, Claim, Finish.
    const retry = await download();
    expect(retry.statusCode).toBe(202);
    await record.until("Finish");
    // Asking again and canceling a ready Download change no row.
    const again = await download();
    expect(again.json().downloadState).toBe("ready");
    const cancel = await request(app, {
      method: "DELETE",
      url: `/sets/${id}/audio/download`,
    });
    expect(cancel.statusCode).toBe(400);
    const audioFiles = async () => {
      const names = await readdir(path.join(root, "audio"));
      return names.filter((name) => name.startsWith(id));
    };
    expect(await audioFiles()).toEqual([`${id}.mp3`]);
    // The Host removes the Set, and nobody else keeps it: Release. The removal
    // answers after the release, so the row and the file agree by then.
    const removed = await request(app, {
      method: "DELETE",
      url: `/sets/${id}`,
    });
    expect(removed.statusCode).toBe(200);
    await record.until("Release");
    expect(record.moves.at(-1)?.state).toBe("none");
    expect(await audioFiles()).toEqual([]);

    expect(record.moves.every((move) => move.setId === id)).toBe(true);
    const observations: readonly Observation[] = [
      { state: { kept: true, state: "none", stored: false } },
      ...record.moves.map((move) => ({
        action: move.move,
        state: { state: move.state },
      })),
    ];
    expect(observations.map((each) => each.action ?? "start")).toEqual([
      "start",
      "Queue",
      "Claim",
      "Fail",
      "Queue",
      "Claim",
      "Finish",
      "Release",
    ]);

    await mkdir(artifactDirectory, { recursive: true });
    const trace = path.join(artifactDirectory, "set-download.jsonl");
    await writeFile(
      trace,
      `${observations.map((each) => JSON.stringify(each)).join("\n")}\n`
    );
    // The file move (Store) and the removal before the release (Unkeep) are not moves,
    // so the log does not show them: one unlogged step may come before each line.
    const conform = everystate([
      "conform",
      "-hidden",
      "1",
      "-trace",
      trace,
      "SetDownload.tla",
    ]);
    await writeFile(
      path.join(artifactDirectory, "set-download.conform.txt"),
      conform.output
    );
    expect(conform.output).toContain("Trace conforms");
    expect(conform.exitCode).toBe(0);

    // The same run without its second Claim is not a behaviour of the spec.
    const tampered = path.join(
      artifactDirectory,
      "set-download-tampered.jsonl"
    );
    const secondClaim = observations
      .map((each) => each.action)
      .lastIndexOf("Claim");
    await writeFile(
      tampered,
      `${observations
        .filter((_each, index) => index !== secondClaim)
        .map((each) => JSON.stringify(each))
        .join("\n")}\n`
    );
    const refused = everystate([
      "conform",
      "-hidden",
      "1",
      "-trace",
      tampered,
      "SetDownload.tla",
    ]);
    await writeFile(
      path.join(artifactDirectory, "set-download-tampered.conform.txt"),
      refused.output
    );
    expect(refused.exitCode).toBe(20);
  } finally {
    await app.dispose();
    await rm(root, { force: true, recursive: true });
  }
});
