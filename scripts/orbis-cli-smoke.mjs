// PAL-2196: drives the `orbis` command line tool against the real service, on Linux or macOS,
// with no simulator. It starts the lane's disposable service and audio seed (as
// `scripts/native-lanes.mjs` does), files two Sets, makes their audio ready, then runs each queue
// command and checks what the tool prints. The transcript is the artifact: one `$ orbis ...` line
// and its output per step, written to the file named by `--out` (default: standard output only).
//
//   bun scripts/orbis-cli-smoke.mjs [--out <file>]
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const root = path.resolve(import.meta.dirname, "..");
const kit = path.join(root, "apps/apple/OrbisKit");
const out = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : undefined;

const freePort = async () => {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  listener.close();
  await once(listener, "close");
  return port;
};

const waitFor = async (url) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Polls one service until it answers.
      await fetch(url, { signal: AbortSignal.timeout(1000) });
      return;
    } catch {
      // oxlint-disable-next-line no-await-in-loop -- Polls one service until it answers.
      await sleep(100);
    }
  }
  throw new Error(`${url} never answered`);
};

const data = mkdtempSync(path.join(tmpdir(), "orbis-cli-smoke-"));
const token = randomBytes(32).toString("base64url");
const port = await freePort();
const seedPort = await freePort();
const address = `http://127.0.0.1:${port}`;
const seed = `http://127.0.0.1:${seedPort}`;
const children = [];

const finish = (code) => {
  for (const child of children) {
    child.kill();
  }
  rmSync(data, { force: true, recursive: true });
  process.exit(code);
};

const build = spawnSync("swift", ["build", "--product", "orbis"], {
  cwd: kit,
  encoding: "utf-8",
});
if (build.status !== 0) {
  console.error(build.stderr);
  finish(1);
}
const binary = spawnSync("swift", ["build", "--show-bin-path"], {
  cwd: kit,
  encoding: "utf-8",
}).stdout.trim();

const service = spawn("bun", ["scripts/fixture.ts"], {
  cwd: root,
  env: {
    ...process.env,
    ORBIS_COBALT_API_KEY: "lane",
    ORBIS_COBALT_URL: `${seed}/cobalt`,
    ORBIS_FIXTURE_DATA_DIR: data,
    ORBIS_FIXTURE_PORT: String(port),
    ORBIS_FIXTURE_SETTINGS_TOKEN: randomBytes(32).toString("base64url"),
    ORBIS_FIXTURE_TOKEN: token,
    ORBIS_OPENROUTER_API_KEY: "",
    ORBIS_YOUTUBE_API_KEY: "",
    ORBIS_YTDLP_BIN: "",
  },
  stdio: ["ignore", "pipe", "inherit"],
});
children.push(service);
await once(service.stdout, "data");
await waitFor(`${address}/queue`);
children.push(
  spawn(
    "bun",
    [
      "scripts/seed-lane-audio.mjs",
      data,
      path.join(root, "scripts/fixtures/ready-set.m4a"),
      String(seedPort),
    ],
    { cwd: root, stdio: ["ignore", "ignore", "inherit"] }
  )
);
await waitFor(seed);

const post = async (route, body) => {
  const response = await fetch(`${address}/${route}`, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });
  return await response.json();
};

const ids = [];
for (const [title, video] of [
  ["Night session", "abcdefghijk"],
  ["Morning session", "bcdefghijkl"],
]) {
  // oxlint-disable-next-line no-await-in-loop -- The Sets are filed one after the other, so the order is known.
  const saved = await post("sets", {
    tags: [],
    title,
    url: `https://www.youtube.com/watch?v=${video}`,
  });
  // oxlint-disable-next-line no-await-in-loop -- Each Set's audio is made ready before the next is filed.
  await fetch(`${seed}/ready-audio/${saved.id}`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });
  ids.push(saved.id);
}

const transcript = [];
let failed = false;
const orbis = (args, expected, status = 0) => {
  const result = spawnSync(path.join(binary, "orbis"), args, {
    encoding: "utf-8",
    env: { ...process.env, ORBIS_ADDRESS: address, ORBIS_TOKEN: token },
  });
  const text = `${result.stdout}${result.stderr}`.trimEnd();
  const wanted = expected.replace("<0>", ids[0]).replace("<1>", ids[1]);
  const ok = text.includes(wanted) && result.status === status;
  failed ||= !ok;
  transcript.push(
    `$ orbis ${args.join(" ")}`,
    ...text.split("\n").map((line) => `  ${line}`),
    `  -> exit ${result.status}${ok ? "" : ` (wanted exit ${status} and: ${wanted})`}`
  );
};

orbis(["queue"], "The queue is empty.");
orbis(["play", ids[0]], "> <0>  Night session");
orbis(["add", ids[1]], "Added to the queue");
orbis(["queue"], "  <1>  Morning session");
orbis(["finish", ids[0]], "> <1>  Morning session");
orbis(["playlist", "missing"], "The service reported 404.", 1);

const text = `${transcript.join("\n")}\n`;
console.log(text);
if (out) {
  writeFileSync(out, text);
}
finish(failed ? 1 : 0);
