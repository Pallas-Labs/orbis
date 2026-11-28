// Resuming a paused Set through the built web client against a real Orbis API
// (e2e/api-server.ts). A resume reads the Set's Playback Position from the
// service first: when another device saved a newer place, the player moves there
// before it plays, so the paused page never writes its old place over the newer
// one (PAL-2130, ADR 0001, ADR 0021). Screenshots and a result.json are the
// artifact.
//
// The audio fixture is 30 s long and the service bounds a position by the Set's
// length. Playback goes on until the pause click lands, so on a busy host the
// page pauses seconds past the place it moved to; each step checks against the
// second the page paused at, and the other device saves a place 8 s after it.
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

// The place another device saves while the page is paused at `pausedAt`: later
// than it, so a resume from the page's own place cannot pass for one from the
// other device's.
const otherDevicePlace = (pausedAt) => pausedAt + 8;

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
          ? {
              currentTime: element.currentTime,
              paused: element.paused,
              seeking: element.seeking,
            }
          : null;
      });
    const queueReads = [];
    const positionSaves = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/queue" && request.method() === "GET") {
        queueReads.push(url.pathname);
      }
      if (
        url.pathname === `/sets/${saved.id}/position` &&
        request.method() === "PUT"
      ) {
        positionSaves.push(request);
      }
    });
    // The player's own play control, which only the `<audio>` element hears.
    const playButton = page
      .getByRole("region", { name: "Audio player" })
      .locator("media-play-button");

    // Moves the playing element to `seconds` and pauses it with the play
    // control, then waits for the pause's own save to reach the service, and
    // answers the second the service holds. Playback goes on until the click
    // lands, so the pause can be seconds past `seconds` on a busy host. The
    // seek must land first: a seek that ends during the next resume's read is
    // the person's choice of place and drops the read. The page sends its saves
    // one at a time, so on a busy host the seek's save can leave after the
    // pause click. The wait takes the seek's save first, then the save of the
    // paused element's own second, so no save of this page can still land
    // after another device's.
    const pauseAt = async (seconds) => {
      const savesBeforeSeek = positionSaves.length;
      await page.evaluate((target) => {
        const element = document.querySelector("audio");
        element.currentTime = target;
      }, seconds);
      await waitUntil(async () => {
        const state = await audioState();
        return (
          !state.seeking &&
          state.currentTime >= seconds &&
          state.currentTime < seconds + 2
        );
      }, `the audio did not move to ${seconds} s`);
      await waitUntil(
        () => positionSaves.length > savesBeforeSeek,
        "the seek did not save its position"
      );
      await positionSaves[savesBeforeSeek].response();
      const savesBefore = positionSaves.length;
      await playButton.click();
      await waitUntil(async () => {
        const state = await audioState();
        return state.paused;
      }, "the play control did not pause the audio");
      const { currentTime: paused } = await audioState();
      const pauseSave = () =>
        positionSaves
          .slice(savesBefore)
          .find((request) => request.postDataJSON().seconds === paused);
      await waitUntil(
        () => pauseSave() !== undefined,
        "the pause did not save its position"
      );
      await pauseSave().response();
      // The service rounds a position to the whole second.
      const held = await servicePosition();
      assert.equal(
        held,
        Math.round(paused),
        `the service holds ${held} s after the pause at ${paused} s (moved to ${seconds} s)`
      );
      return held;
    };
    // Presses play on a paused Set and answers where the sound went on, once it
    // has played half a second past `from`, along with the number of position
    // reads the resume made.
    const resume = async (from, message) => {
      const reads = queueReads.length;
      await playButton.click();
      await waitUntil(async () => {
        const state = await audioState();
        return !state.paused && state.currentTime > from + 0.5;
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
    const otherDevice = otherDevicePlace(pausedAt);
    await api("PUT", `/sets/${saved.id}/position`, { seconds: otherDevice });
    const { reads, seconds: resumedAt } = await resume(
      otherDevice,
      "the page did not resume after another device saved"
    );
    await page.screenshot({
      path: path.join(artifacts, "resumed-at-other-device.png"),
    });
    assert.ok(
      resumedAt >= otherDevice && resumedAt < otherDevice + 4,
      `the page resumed at ${resumedAt} s, not at the other device's ${otherDevice} s`
    );
    assert.equal(reads, 1, "the resume did not read the service's position");
    // The resume's seek is the page's next report.
    await waitUntil(
      async () => (await servicePosition()) >= otherDevice,
      "the page's next report did not keep the other device's place"
    );
    const afterNextReport = await servicePosition();
    assert.ok(
      afterNextReport >= otherDevice,
      `the service holds ${afterNextReport} s after the page reported, not ${otherDevice} s or more`
    );
    step("a resume after another device saved plays from that device's place", {
      afterNextReport,
      otherDevice,
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
      localResume >= localPause && localResume < localPause + 4,
      `the page resumed at ${localResume} s, not at its own ${localPause} s`
    );
    step("a resume with no other save plays from the page's own pause", {
      localPause,
      localResume,
    });

    // 3. The read fails: the resume still plays, from the page's own place.
    const failedPause = await pauseAt(6);
    await api("PUT", `/sets/${saved.id}/position`, {
      seconds: otherDevicePlace(failedPause),
    });
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
      failedResume >= failedPause && failedResume < failedPause + 4,
      `the page resumed at ${failedResume} s after a failed read, not at its own ${failedPause} s`
    );
    step("a resume whose read fails plays from the page's own place", {
      failedPause,
      failedResume,
    });

    // 4. Play twice while the read is out: the page stays quiet and saves
    // nothing until the read answers, then plays from the other device's place.
    const heldPause = await pauseAt(4);
    const heldOther = otherDevicePlace(heldPause);
    await api("PUT", `/sets/${saved.id}/position`, { seconds: heldOther });
    const { promise: readReleased, resolve: releaseRead } =
      Promise.withResolvers();
    await page.route("**/queue", async (route) => {
      if (route.request().method() === "GET") {
        await readReleased;
      }
      await route.continue();
    });
    const readsBefore = queueReads.length;
    const savesBefore = positionSaves.length;
    await playButton.click();
    await waitUntil(
      () => queueReads.length > readsBefore,
      "the first play did not read the service's position"
    );
    await waitUntil(async () => {
      const state = await audioState();
      return state.paused;
    }, "the page did not wait, paused, for the read");
    await playButton.click();
    // Long enough for the element's time updates to report, if they could.
    await page.waitForTimeout(1500);
    const whileHeld = await audioState();
    const savesWhileHeld = positionSaves
      .slice(savesBefore)
      .map((request) => request.postDataJSON().seconds);
    await page.screenshot({
      path: path.join(artifacts, "second-play-while-reading.png"),
    });
    assert.ok(
      whileHeld.paused,
      "a second play sounded before the read answered"
    );
    assert.deepEqual(
      savesWhileHeld,
      [],
      "the page saved a position before the read answered"
    );
    releaseRead();
    await waitUntil(async () => {
      const state = await audioState();
      return !state.paused && state.currentTime > heldOther + 0.5;
    }, "the page did not resume at the other device's place after a second play");
    const { currentTime: heldResume } = await audioState();
    await page.unroute("**/queue");
    assert.ok(
      heldResume >= heldOther && heldResume < heldOther + 4,
      `the page resumed at ${heldResume} s after a second play, not at the other device's ${heldOther} s`
    );
    await waitUntil(
      async () => (await servicePosition()) >= heldOther,
      `the page's next report after a second play did not keep ${heldOther} s`
    );
    const heldService = await servicePosition();
    step(
      "a second play during the read waits for it and keeps the newer place",
      {
        heldPause,
        heldResume,
        heldService,
        otherDevice: heldOther,
        savesWhileHeld,
        whileHeld,
      }
    );

    // 5. The pause's save lands, but its answer is lost (PAL-3192). The page
    // cannot tell that from a failed request, so it sends the pause again
    // once the service answers. The other device then saves the place this
    // page last heard before the loss: only a page that heard the resent
    // pause's answer sees that save as newer and resumes there.
    const answered = [];
    const onAnswer = async (response) => {
      const request = response.request();
      if (
        request.method() === "PUT" &&
        new URL(request.url()).pathname === `/sets/${saved.id}/position` &&
        response.ok()
      ) {
        // An answer that arrives as the browser closes has no body to read.
        const body = await response.json().catch(() => null);
        if (body !== null) {
          answered.push(body.playbackPositionSeconds);
        }
      }
    };
    page.on("response", onAnswer);
    const lostSeek = 3;
    const seekSaves = positionSaves.length;
    await page.evaluate((target) => {
      document.querySelector("audio").currentTime = target;
    }, lostSeek);
    await waitUntil(
      () => positionSaves.length > seekSaves,
      "the seek before the lost answer did not save its position"
    );
    await positionSaves[seekSaves].response();
    await waitUntil(
      () => answered.length > 0,
      "the page heard no answer to a save"
    );
    const lostPaths = `**/sets/${saved.id}/position`;
    const lost = [];
    await page.route(lostPaths, async (route) => {
      if (route.request().method() !== "PUT") {
        await route.continue();
        return;
      }
      // The save reaches the service; the page never hears its answer.
      await route.fetch();
      lost.push(route.request().postDataJSON().seconds);
      await route.abort("failed");
    });
    const heard = answered.at(-1);
    // Every save from here on reaches the service unheard, the seek's too, so
    // the page's known place stays at `heard`.
    const lostTo = 10;
    await page.evaluate((target) => {
      document.querySelector("audio").currentTime = target;
    }, lostTo);
    await waitUntil(async () => {
      const state = await audioState();
      return (
        !state.seeking &&
        state.currentTime >= lostTo &&
        state.currentTime < lostTo + 2
      );
    }, `the audio did not move to ${lostTo} s`);
    await playButton.click();
    await waitUntil(async () => {
      const state = await audioState();
      return state.paused;
    }, "the play control did not pause the audio before the lost answer");
    const { currentTime: lostPause } = await audioState();
    await waitUntil(
      () => lost.includes(lostPause),
      "the pause's save did not reach the service"
    );
    const storedWhileLost = await servicePosition();
    assert.equal(storedWhileLost, Math.round(lostPause));
    assert.notEqual(
      heard,
      storedWhileLost,
      `the page last heard ${heard} s, the same as its pause`
    );
    const savesAfterLoss = positionSaves.length;
    const answersAfterLoss = answered.length;
    await page.unroute(lostPaths);
    // The page resends on a 15 s tick, so this waits up to 30 s.
    await waitUntil(
      () => answered.length > answersAfterLoss,
      "the page did not send its pause again after the service answered",
      150
    );
    const resent = positionSaves
      .slice(savesAfterLoss)
      .map((request) => request.postDataJSON().seconds);
    assert.equal(
      resent[0],
      lostPause,
      `the page resent ${resent[0]} s, not its pause at ${lostPause} s`
    );
    assert.equal(answered[answersAfterLoss], Math.round(lostPause));
    await api("PUT", `/sets/${saved.id}/position`, { seconds: heard });
    // The other device's place is behind the pause, so the element plays past
    // it for a moment after the click, before the page holds it for the read.
    // The wait starts once the read has gone out.
    const readsBeforeResume = queueReads.length;
    await playButton.click();
    await waitUntil(
      () => queueReads.length > readsBeforeResume,
      "the resume after the resent pause did not read the service's position"
    );
    await waitUntil(async () => {
      const state = await audioState();
      return !state.paused && state.currentTime > heard + 0.5;
    }, "the page did not resume after its pause was sent again");
    const { currentTime: afterLoss } = await audioState();
    await page.screenshot({
      path: path.join(artifacts, "resumed-after-lost-answer.png"),
    });
    page.off("response", onAnswer);
    assert.ok(
      afterLoss >= heard && afterLoss < heard + 4,
      `the page resumed at ${afterLoss} s, not at the other device's ${heard} s`
    );
    step("a pause whose answer is lost is sent again and heard", {
      heard,
      lost,
      lostPause,
      resent,
      resumedAt: afterLoss,
      storedWhileLost,
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
