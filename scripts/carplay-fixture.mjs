// Starts a disposable Orbis service with a library worth looking at in the CarPlay simulator:
// playable Sets with artwork and creators, two left part-way, one Set still downloading, a
// Tracklist, and two Playlists. It prints the launch command for a simulator and keeps running
// until interrupted.
//
//   bun scripts/carplay-fixture.mjs [--udid <simulator UUID>]
//
// Requires ffmpeg for the artwork images.
import { Database } from "bun:sqlite";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const udidFlag = process.argv.indexOf("--udid");
const udid = udidFlag === -1 ? "booted" : process.argv[udidFlag + 1];

const unusedPort = async () => {
  const listener = createServer();
  const listening = once(listener, "listening");
  listener.listen(0, "127.0.0.1");
  await listening;
  const { port } = listener.address();
  const closed = once(listener, "close");
  listener.close();
  await closed;
  return port;
};

/** Runs `run` once for each item, one at a time in the order given. */
const runInOrder = async (items, run) => {
  const iterator = items[Symbol.iterator]();
  const step = async (index) => {
    const next = iterator.next();
    if (next.done === true) {
      return;
    }
    await run(next.value, index);
    await step(index + 1);
  };
  await step(0);
};

/** Polls `url` until it answers, 100 attempts 100 ms apart. */
const waitFor = async (url) => {
  const attempt = async (attemptsLeft) => {
    try {
      await fetch(url, { signal: AbortSignal.timeout(5000) });
      return;
    } catch {
      // Not listening yet.
      if (attemptsLeft <= 1) {
        throw new Error(`${url} did not answer`);
      }
    }
    await Bun.sleep(100);
    await attempt(attemptsLeft - 1);
  };
  await attempt(100);
};

const dataDirectory = mkdtempSync(path.join(tmpdir(), "orbis-carplay-"));
const artworkDirectory = path.join(dataDirectory, "artwork");
mkdirSync(artworkDirectory);
const [port, seedPort, artworkPort] = await Promise.all([
  unusedPort(),
  unusedPort(),
  unusedPort(),
]);
const address = `http://127.0.0.1:${port}`;
const seedAddress = `http://127.0.0.1:${seedPort}`;
const token = randomBytes(32).toString("base64url");

const children = [];
const stop = () => {
  for (const child of children) {
    child.kill("SIGTERM");
  }
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stop();
    process.exit(0);
  });
}

const fixture = spawn("bun", ["scripts/fixture.ts"], {
  cwd: root,
  env: {
    ...process.env,
    ORBIS_COBALT_API_KEY: "carplay",
    ORBIS_COBALT_URL: `${seedAddress}/cobalt`,
    ORBIS_FIXTURE_DATA_DIR: dataDirectory,
    ORBIS_FIXTURE_PORT: String(port),
    ORBIS_FIXTURE_TOKEN: token,
    ORBIS_OPENROUTER_API_KEY: "",
    ORBIS_YOUTUBE_API_KEY: "",
    ORBIS_YTDLP_BIN: "",
  },
  stdio: ["ignore", "pipe", "inherit"],
});
children.push(fixture);
await once(fixture.stdout, "data");
await waitFor(`${address}/health`);

children.push(
  spawn(
    "bun",
    [
      "scripts/seed-lane-audio.mjs",
      dataDirectory,
      path.join(root, "scripts", "fixtures", "ready-set.m4a"),
      String(seedPort),
    ],
    { cwd: root, stdio: ["ignore", "ignore", "inherit"] }
  )
);
await waitFor(`${seedAddress}/health`);

const sets = [
  ["Boiler Room Berlin", "Ellen Allien", "#ff5f6d:#ffc371"],
  ["Sunrise at Dekmantel", "Job Jobse", "#2193b0:#6dd5ed"],
  ["Essential Mix", "Four Tet", "#cc2b5e:#753a88"],
  ["Warehouse Project", "Peggy Gou", "#ee9ca7:#ffdde1"],
  ["Lot Radio Session", "Avalon Emerson", "#42275a:#734b6d"],
  ["Panorama Bar Closing", "Prosumer", "#bdc3c7:#2c3e50"],
  ["Rinse FM Takeover", "Shy One", "#de6262:#ffb88c"],
  ["NTS Live", "Call Super", "#06beb6:#48b1bf"],
];

const artworkServer = Bun.serve({
  fetch: (request) =>
    new Response(
      Bun.file(
        path.join(
          artworkDirectory,
          path.basename(new URL(request.url).pathname)
        )
      )
    ),
  hostname: "127.0.0.1",
  port: artworkPort,
});

const api = async (method, route, body) => {
  const response = await fetch(`${address}/${route}`, {
    // oxlint-disable-next-line unicorn/no-invalid-fetch-options -- Every caller writes with POST or PUT.
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`${method} ${route} answered ${response.status}`);
  }
  return response.status === 204 ? null : await response.json();
};

const seed = async (route) => {
  const response = await fetch(`${seedAddress}/${route}`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 204) {
    throw new Error(`seeding ${route} answered ${response.status}`);
  }
};

const db = new Database(path.join(dataDirectory, "library.sqlite"));
const saved = [];
// Sets are filed in order, newest last.
await runInOrder(sets.entries(), async ([index, [title, creator, colors]]) => {
  const [from, to] = colors.split(":");
  const image = path.join(artworkDirectory, `${index}.png`);
  const made = spawnSync("ffmpeg", [
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `gradients=s=600x600:c0=${from}:c1=${to}:x0=0:y0=0:x1=600:y1=600`,
    "-frames:v",
    "1",
    image,
  ]);
  if (made.status !== 0) {
    throw new Error(`ffmpeg could not draw ${image}`);
  }
  const set = await api("POST", "sets", {
    tags: ["techno"],
    title,
    url: `https://www.youtube.com/watch?v=carplay${String(index).padStart(4, "0")}`,
  });
  db.query("UPDATE sets SET creator = ?, artwork_url = ? WHERE id = ?").run(
    creator,
    `http://127.0.0.1:${artworkPort}/${index}.png`,
    set.id
  );
  saved.push(set);
});

const [downloading, ...playable] = saved;
// The seed server copies one file at a time.
await runInOrder(playable, (set) => seed(`ready-audio/${set.id}`));
await seed(`tracklist/${playable[0].id}`);

// Each Listen starts after the last.
await runInOrder(playable.slice(0, 3), async (set) => {
  await api("PUT", "queue/active", { setId: set.id });
  await api("PUT", `sets/${set.id}/position`, { seconds: 10 });
});

const late = await api("POST", "playlists", { name: "Late night" });
await api("PUT", `playlists/${late.id}/sets`, {
  setIds: [playable[0].id, playable[2].id, downloading.id, playable[4].id],
});
const warmUp = await api("POST", "playlists", { name: "Warm up" });
await api("PUT", `playlists/${warmUp.id}/sets`, {
  setIds: [playable[1].id, playable[3].id],
});

console.log(
  JSON.stringify(
    {
      address,
      artwork: artworkServer.url.href,
      dataDirectory,
      launch: `xcrun simctl launch ${udid} app.orbis.client -orbisServiceAddress ${address} -orbisSignedInWith ${token}`,
    },
    null,
    2
  )
);
