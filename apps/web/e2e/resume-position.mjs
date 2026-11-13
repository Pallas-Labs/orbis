// Resuming a paused Set through the built web client against a real Orbis API
// (e2e/api-server.ts). A resume reads the Set's Playback Position from the
// service first: when another device saved a newer place, the player moves there
// before it plays, so the paused page never writes its old place over the newer
// one (PAL-2130, ADR 0001, ADR 0021). Screenshots and a result.json are the
// artifact.
//
// The audio fixture is 30 s long and the service bounds a position by the Set's
// length, so the journey pauses at 5 s and the other device saves 20 s.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "playwright";

import {
  freePort,
  keyRecord,
  signInWithKey,
  startApi,
  startPreview,
  waitFor,
  waitUntil,
} from "./helpers.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const artifacts = path.join(root, ".cache/web-resume-position");
const devicePort = await freePort();
const webPort = await freePort();
const apiUrl = `http://127.0.0.1:${devicePort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const key = randomBytes(24).toString("base64url");

// The same Person from a second client, as another device would call the API.
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

const dataDirectory = await mkdtemp(path.join(tmpdir(), "orbis-resume-"));
await writeFile(
  path.join(dataDirectory, "devices.json"),
  JSON.stringify({
    keys: [keyRecord("journey-key", "Resume journey", "host", key)],
    people: [
      { autoDownload: false, id: "host", removed: false, username: "host" },
    ],
    version: 2,
  })
);
const server = startApi({ dataDirectory, origin: webUrl, port: devicePort });
const web = startPreview({ apiUrl, port: webPort });

const steps = [];
const step = (name, detail = {}) => steps.push({ name, ...detail });
try {
  await Promise.all([
    waitFor(`${apiUrl}/health`, server),
    waitFor(webUrl, web),
  ]);
  await mkdir(artifacts, { recursive: true });

  const saved = await api("POST", "/sets", {
    url: "https://www.youtube.com/watch?v=rrrrrrrrrrr",
  });
  await api("PATCH", `/sets/${saved.id}/title`, { title: "Resumed set" });
  await api("POST", `/sets/${saved.id}/audio/download`);
  await waitUntil(async () => {
    const { sets } = await api("GET", "/sets");
    return sets.every((set) => set.downloadState === "ready");
  }, "the Download did not finish");
  const servicePosition = async () => {
    const { sets } = await api("GET", "/sets");
    return sets.find((set) => set.id === saved.id).playbackPositionSeconds;
  };

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const audioState = () =>
      page.evaluate(() => {
        const element = document.querySelector("audio");
        return element
          ? { currentTime: element.currentTime, paused: element.paused }
          : null;
      });
    const queueReads = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/queue" && request.method() === "GET") {
        queueReads.push(url.pathname);
      }
    });
    // The player's own play control, which only the `<audio>` element hears.
    const playButton = page
      .getByRole("region", { name: "Audio player" })
      .locator("media-play-button");

    // Moves the playing element to `seconds` and pauses it there with the play
    // control, then waits for the pause's save to reach the service.
    const pauseAt = async (seconds) => {
      await page.evaluate((target) => {
        const element = document.querySelector("audio");
        element.currentTime = target;
      }, seconds);
      await waitUntil(async () => {
        const state = await audioState();
        return state.currentTime >= seconds && state.currentTime < seconds + 2;
      }, `the audio did not move to ${seconds} s`);
      await playButton.click();
      await waitUntil(async () => {
        const state = await audioState();
        return state.paused;
      }, "the play control did not pause the audio");
      await waitUntil(
        async () => Math.abs((await servicePosition()) - seconds) <= 1,
        `the pause at ${seconds} s did not reach the service`
      );
      return await servicePosition();
    };
    // Presses play on a Set paused at `pausedAt` and answers where the sound
    // went on, once it has played half a second past the pause, along with the
    // number of position reads the resume made.
    const resume = async (pausedAt, message) => {
      const reads = queueReads.length;
      await playButton.click();
      await waitUntil(async () => {
        const state = await audioState();
        return !state.paused && state.currentTime > pausedAt + 0.5;
      }, message);
      const state = await audioState();
      return {
        reads: queueReads.length - reads,
        seconds: state.currentTime,
      };
    };

    await signInWithKey(page, webUrl, key);
    await page.getByRole("heading", { name: "Library" }).waitFor();
    await page.getByRole("button", { name: "Actions for Resumed set" }).click();
    await page.getByRole("menuitem", { exact: true, name: "Play" }).click();
    await waitUntil(async () => {
      const state = await audioState();
      return state !== null && !state.paused && state.currentTime > 0.3;
    }, "the audio did not start");
    step("the Set plays in the page");

    // 1. Another device saves a later place while the page is paused.
    const pausedAt = await pauseAt(5);
    await api("PUT", `/sets/${saved.id}/position`, { seconds: 20 });
    const { reads, seconds: resumedAt } = await resume(
      pausedAt,
      "the page did not resume after another device saved"
    );
    await page.screenshot({
      path: path.join(artifacts, "resumed-at-other-device.png"),
    });
    assert.ok(
      resumedAt >= 20 && resumedAt < 24,
      `the page resumed at ${resumedAt} s, not at the other device's 20 s`
    );
    assert.equal(reads, 1, "the resume did not read the service's position");
    // The resume's seek is the page's next report.
    await waitUntil(
      async () => (await servicePosition()) >= 20,
      "the page's next report did not keep the other device's place"
    );
    const afterNextReport = await servicePosition();
    assert.ok(
      afterNextReport >= 20,
      `the service holds ${afterNextReport} s after the page reported, not 20 s or more`
    );
    step("a resume after another device saved plays from that device's place", {
      afterNextReport,
      otherDevice: 20,
      pausedAt,
      reads,
      resumedAt,
    });

    // 2. Nobody else saves: the resume plays from where the page paused.
    const localPause = await pauseAt(8);
    const { seconds: localResume } = await resume(
      localPause,
      "the page did not resume from its own pause"
    );
    await page.screenshot({
      path: path.join(artifacts, "resumed-at-own-pause.png"),
    });
    assert.ok(
      localResume >= 8 && localResume < 12,
      `the page resumed at ${localResume} s, not at its own 8 s`
    );
    step("a resume with no other save plays from the page's own pause", {
      localPause,
      localResume,
    });

    // 3. The read fails: the resume still plays, from the page's own place.
    const failedPause = await pauseAt(6);
    await api("PUT", `/sets/${saved.id}/position`, { seconds: 25 });
    await page.route("**/queue", async (route) => {
      await (route.request().method() === "GET"
        ? route.abort("failed")
        : route.continue());
    });
    const { seconds: failedResume } = await resume(
      failedPause,
      "the page did not resume when the read failed"
    );
    await page.unroute("**/queue");
    assert.ok(
      failedResume >= 6 && failedResume < 10,
      `the page resumed at ${failedResume} s after a failed read, not at its own 6 s`
    );
    step("a resume whose read fails plays from the page's own place", {
      failedPause,
      failedResume,
    });
  } finally {
    await browser.close();
  }
  await writeFile(
    path.join(artifacts, "result.json"),
    `${JSON.stringify({ apiUrl, steps, webUrl }, null, 2)}\n`
  );
  console.log(
    `resume-position journey passed: ${steps.length} steps, artifacts in ${artifacts}`
  );
} finally {
  server.kill("SIGTERM");
  web.kill("SIGTERM");
  await rm(dataDirectory, { force: true, recursive: true });
}
