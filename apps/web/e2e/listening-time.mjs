// Listening Time through the built web client against a real Orbis API (e2e/api-server.ts):
// a Set plays from the start, seeks ahead, and plays out. Orbis credits Listening Time from the
// steps between Playback Position saves (`listenedBetween`), so the client saves the place it
// leaves before a seek, or the seconds before the seek go uncounted (PAL-2133). The saves, the
// seconds played and the seconds credited are the artifact, in result.json.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "playwright";

import {
  freePort,
  signInWithKey,
  startApi,
  startPreview,
  waitFor,
  waitUntil,
} from "./helpers.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const artifacts = path.join(root, ".cache/web-listening-time");
const devicePort = await freePort();
const webPort = await freePort();
const apiUrl = `http://127.0.0.1:${devicePort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const key = randomBytes(24).toString("base64url");
// The fixture audio is 30 s. The Set plays to here, seeks ahead to there, and plays out.
const seekFrom = 8;
const seekTo = 15;
// As the service's own slack (`HEAVY_ROTATION.slackSeconds`).
const slackSeconds = 3;

const api = async (method, route, body) => {
  const init = {
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    method,
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${apiUrl}${route}`, init);
  assert.ok(response.ok, `${method} ${route} answered ${response.status}`);
  return response.status === 204 ? null : await response.json();
};

const dataDirectory = await mkdtemp(path.join(tmpdir(), "orbis-listening-"));
const databasePath = path.join(dataDirectory, "library.sqlite");
await writeFile(
  path.join(dataDirectory, "devices.json"),
  JSON.stringify({
    keys: [
      {
        addedAt: new Date().toISOString(),
        id: "journey-key",
        label: "Listening Time journey",
        lastUsedAt: null,
        personId: "host",
        scope: "daily",
        tokenHash: createHash("sha256").update(key).digest("hex"),
      },
    ],
    people: [
      { autoDownload: false, id: "host", removed: false, username: "host" },
    ],
    version: 2,
  })
);
const server = startApi({ dataDirectory, origin: webUrl, port: devicePort });
const web = startPreview({ apiUrl, port: webPort });

/** The seconds of Listening Time the service holds for `setId`, over every day. */
const creditedSeconds = (setId) =>
  Number(
    execFileSync("bun", [
      "-e",
      `import { Database } from "bun:sqlite";
       const db = new Database(process.argv[1], { readonly: true });
       const row = db.query("SELECT coalesce(sum(seconds), 0) AS seconds FROM listening_time WHERE set_id = ?").get(process.argv[2]);
       console.log(row.seconds);
       db.close();`,
      databasePath,
      setId,
    ])
      .toString()
      .trim()
  );

const steps = [];
const step = (name, detail = {}) => steps.push({ name, ...detail });
try {
  await Promise.all([
    waitFor(`${apiUrl}/health`, server),
    waitFor(webUrl, web),
  ]);
  await mkdir(artifacts, { recursive: true });

  const saved = await api("POST", "/sets", {
    url: "https://www.youtube.com/watch?v=lllllllllll",
  });
  await api("PATCH", `/sets/${saved.id}/title`, { title: "Long set" });
  await api("POST", `/sets/${saved.id}/audio/download`);
  await waitUntil(async () => {
    const state = await api("GET", `/sets/${saved.id}/audio/state`);
    return state.state === "ready";
  }, "the Download did not finish");
  step("a Set with kept audio is in the Library");

  // Chromium plays the fixture headless; autoplay needs no user gesture here.
  const browser = await chromium.launch({
    args: ["--autoplay-policy=no-user-gesture-required"],
    headless: true,
  });
  try {
    const page = await browser.newPage();
    const started = Date.now();
    const saves = [];
    const writes = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === `/sets/${saved.id}/position`) {
        const { seconds } = request.postDataJSON();
        saves.push({ atMs: Date.now() - started, seconds });
        writes.push(`position ${Math.round(seconds)}`);
      } else if (url.pathname === "/queue/completion") {
        writes.push("completion");
      }
    });
    const completed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/queue/completion" &&
        response.ok(),
      { timeout: 60_000 }
    );
    await signInWithKey(page, webUrl, key);
    await page.getByRole("heading", { name: "Library" }).waitFor();

    await page.getByRole("button", { name: "Actions for Long set" }).click();
    await page.getByRole("menuitem", { exact: true, name: "Play" }).click();
    await page.getByRole("region", { name: "Audio player" }).waitFor();
    // The element goes with the Set when it ends, so it keeps what it played on the page.
    await page.waitForFunction(() => {
      const audio = document.querySelector("audio");
      if (audio === null || audio.paused || audio.currentTime <= 0) {
        return false;
      }
      audio.addEventListener("ended", () => {
        let played = 0;
        for (let i = 0; i < audio.played.length; i += 1) {
          played += audio.played.end(i) - audio.played.start(i);
        }
        window.playedSeconds = played;
      });
      return true;
    });
    step("the Set plays from the start");

    await page.waitForFunction(
      (at) => (document.querySelector("audio")?.currentTime ?? 0) >= at,
      seekFrom,
      { timeout: 20_000 }
    );
    await page.evaluate((to) => {
      const audio = document.querySelector("audio");
      if (audio !== null) {
        audio.currentTime = to;
      }
    }, seekTo);
    step("it seeks ahead", { from: seekFrom, to: seekTo });

    await completed;
    const playedSeconds = await page.evaluate(() => window.playedSeconds);
    assert.ok(Number.isFinite(playedSeconds), "the Set did not play out");
    step("it plays out, and Orbis hears the completion");

    const credited = creditedSeconds(saved.id);
    const result = {
      credited,
      playedSeconds,
      saves,
      seekFrom,
      seekTo,
      slackSeconds,
      writes,
    };
    await writeFile(
      path.join(artifacts, "listening.json"),
      `${JSON.stringify(result, null, 2)}\n`
    );
    // The save of the place left goes before the save of the new place.
    const before = saves.findIndex(
      (save) => save.seconds >= seekFrom - 1 && save.seconds < seekTo
    );
    const after = saves.findIndex((save) => save.seconds >= seekTo);
    assert.ok(
      before !== -1,
      `no save of the place left: ${JSON.stringify(saves)}`
    );
    assert.ok(
      before < after,
      `the place left saved after the new place: ${JSON.stringify(saves)}`
    );
    assert.deepEqual(writes.slice(-3), [
      "position 30",
      "position 0",
      "completion",
    ]);

    assert.ok(
      Math.abs(credited - playedSeconds) <= slackSeconds,
      `Orbis credited ${credited} s of ${playedSeconds.toFixed(1)} s played: ${JSON.stringify(saves)}`
    );
    step("Orbis credits the seconds played, within the slack", {
      credited,
      playedSeconds,
    });
  } finally {
    await browser.close();
  }
  await writeFile(
    path.join(artifacts, "result.json"),
    `${JSON.stringify({ apiUrl, steps, webUrl }, null, 2)}\n`
  );
  console.log(
    `listening-time journey passed: ${steps.length} steps, artifacts in ${artifacts}`
  );
} finally {
  server.kill("SIGTERM");
  web.kill("SIGTERM");
  await rm(dataDirectory, { force: true, recursive: true });
}
