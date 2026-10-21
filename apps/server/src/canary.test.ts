/* oxlint-disable no-await-in-loop -- Each canary run reads the state the previous run left. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Schema } from "effect";

const OtlpAttribute = Schema.Struct({
  key: Schema.String,
  value: Schema.Struct({
    boolValue: Schema.optional(Schema.Boolean),
    stringValue: Schema.optional(Schema.String),
  }),
});
const OtlpBody = Schema.Struct({
  resourceLogs: Schema.Array(
    Schema.Struct({
      resource: Schema.Struct({ attributes: Schema.Array(OtlpAttribute) }),
      scopeLogs: Schema.Array(
        Schema.Struct({
          logRecords: Schema.Array(
            Schema.Struct({
              attributes: Schema.Array(OtlpAttribute),
              severityText: Schema.String,
            })
          ),
        })
      ),
    })
  ),
});
const LastRun = Schema.Struct({
  ok: Schema.Boolean,
  sourcesWithoutBackend: Schema.Array(Schema.String),
});

let directory = "";
const bodies: (typeof OtlpBody.Type)[] = [];
let collector: ReturnType<typeof Bun.serve> | undefined;
let cobalt: ReturnType<typeof Bun.serve> | undefined;

const silence = async (seconds: number, file: string) => {
  const generated = Bun.spawn([
    "ffmpeg",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=8000:cl=mono",
    "-t",
    String(seconds),
    "-b:a",
    "8k",
    file,
  ]);
  expect(await generated.exited).toBe(0);
};

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "orbis-canary-"));
  await silence(597, path.join(directory, "short.mp3"));
  await silence(7000, path.join(directory, "long.mp3"));
  await writeFile(
    path.join(directory, "yt-dlp"),
    `#!/usr/bin/env python3
import os, shutil, sys
here = ${JSON.stringify(directory)}
if '--version' in sys.argv:
    print('fixture')
    sys.exit(0)
if any('soundcloud' in arg for arg in sys.argv) and os.path.exists(os.path.join(here, 'fail-soundcloud')):
    sys.exit('ERROR: fixture soundcloud refused')
name = 'short.mp3' if any('YE7VzlLtp-4' in arg for arg in sys.argv) else 'long.mp3'
shutil.copyfile(os.path.join(here, name), sys.argv[sys.argv.index('-o') + 1])
`,
    { mode: 0o755 }
  );
  collector = Bun.serve({
    fetch: async (request) => {
      bodies.push(Schema.decodeUnknownSync(OtlpBody)(await request.json()));
      return Response.json({});
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  // Our Cobalt cannot fetch SoundCloud's HLS AAC; here it refuses every source.
  cobalt = Bun.serve({
    fetch: () =>
      Response.json(
        { error: { code: "error.api.fetch.empty" }, status: "error" },
        { status: 400 }
      ),
    hostname: "127.0.0.1",
    port: 0,
  });
});

afterAll(async () => {
  await collector?.stop(true);
  await cobalt?.stop(true);
  await rm(directory, { force: true, recursive: true });
});

const runCanary = async () => {
  bodies.length = 0;
  const child = Bun.spawn([process.execPath, "src/canary.ts"], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      NODE_ENV: "production",
      ORBIS_COBALT_API_KEY: "fixture",
      ORBIS_COBALT_URL: `http://127.0.0.1:${cobalt?.port}/`,
      ORBIS_DATA_DIR: directory,
      ORBIS_OTLP_LOGS_URL: `http://127.0.0.1:${collector?.port}/v1/logs`,
      ORBIS_YTDLP_BIN: path.join(directory, "yt-dlp"),
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const exitCode = await child.exited;
  const last = Schema.decodeUnknownSync(LastRun)(
    JSON.parse(
      await readFile(path.join(directory, "canary", "last.json"), "utf8")
    )
  );
  const canaryEvents = bodies
    .flatMap((body) => body.resourceLogs)
    .flatMap((resource) =>
      resource.scopeLogs.flatMap((scope) =>
        scope.logRecords.map((record) => ({ record, resource }))
      )
    )
    .filter(({ record }) =>
      record.attributes.some(
        (entry) =>
          entry.key === "job" && entry.value.stringValue === "download-canary"
      )
    );
  return { canaryEvents, exitCode, last };
};

test("a canary with one failing backend per source warns, and one with a dead source errors", async () => {
  const degraded = await runCanary();
  expect(degraded.exitCode).toBe(1);
  expect(degraded.last).toMatchObject({ ok: false, sourcesWithoutBackend: [] });
  expect(degraded.canaryEvents).toHaveLength(1);
  const [warned] = degraded.canaryEvents;
  expect(warned?.record.severityText).toBe("WARN");
  expect(warned?.resource.attributes).toContainEqual({
    key: "orbis.component",
    value: { stringValue: "canary" },
  });
  expect(warned?.record.attributes).toContainEqual({
    key: "ok",
    value: { boolValue: false },
  });

  await writeFile(path.join(directory, "fail-soundcloud"), "");
  const broken = await runCanary();
  expect(broken.exitCode).toBe(1);
  expect(broken.last).toMatchObject({
    ok: false,
    sourcesWithoutBackend: ["soundcloud"],
  });
  expect(broken.canaryEvents).toHaveLength(1);
  const [failed] = broken.canaryEvents;
  expect(failed?.record.severityText).toBe("ERROR");
  expect(JSON.stringify(failed?.record.attributes)).toContain("soundcloud");
}, 120_000);
