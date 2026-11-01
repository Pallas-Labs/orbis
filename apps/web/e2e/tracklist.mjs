// A real browser, API, and SQLite database verify the Set page and Cue seek.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "playwright";

import { signInWithKey, waitFor, waitUntil } from "./helpers.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const artifacts = path.join(root, ".cache/web-tracklist");
const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "orbis-tracklist-web-")
);
const ports = { api: 4530, device: 4531, web: 3431 };
const apiUrl = `http://127.0.0.1:${ports.device}`;
const webUrl = `http://127.0.0.1:${ports.web}`;
const key = randomBytes(24).toString("base64url");
const steps = [];

const call = async (method, route, payload) => {
  const headers = { authorization: `Bearer ${key}` };
  const init = { headers, method };
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(payload);
  }
  const response = await fetch(`${apiUrl}${route}`, init);
  const body = await response.json();
  assert.ok(response.ok, `${method} ${route}: ${response.status}`);
  return body;
};

await writeFile(
  path.join(dataDirectory, "devices.json"),
  JSON.stringify({
    keys: [
      {
        addedAt: new Date().toISOString(),
        id: "tracklist-web-key",
        label: "Tracklist web journey",
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

const api = spawn("bun", ["apps/web/e2e/api-server.ts"], {
  cwd: root,
  env: {
    ...process.env,
    ORBIS_DATA_DIR: dataDirectory,
    ORBIS_FIXTURE_ORIGIN: webUrl,
    ORBIS_FIXTURE_PORT: String(ports.device),
  },
  stdio: "ignore",
});
const web = spawn(
  "bun",
  [
    "x",
    "vite",
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    String(ports.web),
    "--strictPort",
  ],
  {
    cwd: path.join(root, "apps/web"),
    env: { ...process.env, ORBIS_API_URL: apiUrl },
    stdio: "ignore",
  }
);

try {
  await Promise.all([waitFor(`${apiUrl}/health`), waitFor(webUrl)]);
  await mkdir(artifacts, { recursive: true });
  const saved = await call("POST", "/sets", {
    title: "Tracklist journey Set",
    url: "https://www.youtube.com/watch?v=abcdefghijk",
  });
  await call("POST", `/sets/${saved.id}/audio/download`);
  await waitUntil(async () => {
    const state = await call("GET", `/sets/${saved.id}/audio/state`);
    return state.state === "ready";
  }, "audio Download did not finish");

  execFileSync("bun", [
    "-e",
    `import { Database } from "bun:sqlite";
     const db = new Database(process.argv[1]);
     db.query("UPDATE sets SET tracklist_state = 'ready' WHERE id = ?").run(process.argv[2]);
     const insert = db.query("INSERT INTO set_cues (set_id, position, start_seconds, artist, title, artwork_url) VALUES (?, ?, ?, ?, ?, ?)");
     insert.run(process.argv[2], 0, 0, "First Artist", "Opening", null);
     insert.run(process.argv[2], 1, 12, "Second Artist", "Middle", null);
     insert.run(process.argv[2], 2, null, "Third Artist", "Untimed", null);
     db.close();`,
    path.join(dataDirectory, "library.sqlite"),
    saved.id,
  ]);
  steps.push("a saved Set has playable audio and three persisted Cues");

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await signInWithKey(page, webUrl, key);
    await page.getByRole("heading", { name: "Library" }).waitFor();
    await page.getByRole("link", { name: "Tracklist journey Set" }).click();
    await page.waitForURL(`${webUrl}/sets/${saved.id}`);
    const list = page.getByRole("list", { name: "Tracklist" });
    await list
      .getByRole("button", { name: "Middle, Second Artist, starts at 0:12" })
      .waitFor();
    assert.equal(await list.getByRole("listitem").count(), 3);
    assert.equal(await list.getByRole("button").count(), 2);
    await page.screenshot({
      fullPage: true,
      path: path.join(artifacts, "set-tracklist.png"),
    });
    steps.push("Set page shows three Cues; the untimed Cue is not a button");

    const firstPlayHeld = Promise.withResolvers();
    const firstPlayObserved = Promise.withResolvers();
    const firstPlayDelivered = Promise.withResolvers();
    let playResponses = 0;
    await page.route("**/queue/active", async (route) => {
      const response = await route.fetch();
      playResponses += 1;
      const responseNumber = playResponses;
      if (responseNumber === 1) {
        firstPlayObserved.resolve();
        await firstPlayHeld.promise;
      }
      await route.fulfill({ response });
      if (responseNumber === 1) {
        firstPlayDelivered.resolve();
      }
    });
    await list
      .getByRole("button", { name: "Opening, First Artist, starts at 0:00" })
      .click();
    await firstPlayObserved.promise;
    await list
      .getByRole("button", { name: "Middle, Second Artist, starts at 0:12" })
      .click();
    const audio = page.locator('audio[data-slot="audio-player-element"]');
    await audio.waitFor({ state: "attached" });
    await page.waitForFunction(() => {
      const element = document.querySelector(
        'audio[data-slot="audio-player-element"]'
      );
      return element && element.currentTime >= 12;
    });
    await page.waitForFunction(() =>
      [...document.querySelectorAll('ol[aria-label="Tracklist"] button')].some(
        (button) =>
          button.getAttribute("aria-current") === "true" &&
          button.textContent?.includes("Middle")
      )
    );
    firstPlayHeld.resolve();
    await firstPlayDelivered.promise;
    await page.waitForTimeout(200);
    assert.ok(await audio.evaluate((element) => element.currentTime >= 12));
    assert.equal(
      await list
        .getByRole("button", { name: "Middle, Second Artist, starts at 0:12" })
        .getAttribute("aria-current"),
      "true"
    );
    await page.unroute("**/queue/active");
    await page.screenshot({
      fullPage: true,
      path: path.join(artifacts, "cue-playing.png"),
    });
    steps.push("the latest rapid Cue tap wins and seeks audio to 12 seconds");

    const opening = list.getByRole("button", {
      name: "Opening, First Artist, starts at 0:00",
    });
    await opening.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => {
      const element = document.querySelector(
        'audio[data-slot="audio-player-element"]'
      );
      return element && element.currentTime < 2;
    });
    steps.push("a keyboard user can activate a Cue");

    await page.setViewportSize({ height: 812, width: 375 });
    await page.screenshot({
      fullPage: true,
      path: path.join(artifacts, "phone-tracklist.png"),
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      ),
      true
    );
    steps.push("Tracklist fits phone width");

    await page.setViewportSize({ height: 900, width: 1280 });
    const refresh = page.getByRole("button", { name: "Refresh tracklist" });
    await refresh.waitFor();
    // The journey's API has no Versos, so the refresh settles at once. One routed read holds
    // the pending answer long enough to show what a person sees while Versos scans.
    await page.route(
      `**/sets/${saved.id}/tracklist`,
      async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({ json: { ...body, state: "pending" }, response });
      },
      { times: 1 }
    );
    const refreshed = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/sets/${saved.id}/tracklist/retry`) &&
        response.request().method() === "POST"
    );
    await refresh.click();
    const refreshResponse = await refreshed;
    assert.equal(refreshResponse.status(), 200);
    await page
      .getByRole("status")
      .filter({ hasText: "Finding tracklist…" })
      .waitFor();
    assert.equal(await list.getByRole("listitem").count(), 3);
    await page.screenshot({
      fullPage: true,
      path: path.join(artifacts, "tracklist-refreshing.png"),
    });
    await page
      .getByRole("status")
      .filter({ hasText: "Finding tracklist…" })
      .waitFor({ state: "detached" });
    assert.equal(await list.getByRole("listitem").count(), 3);
    await refresh.waitFor();
    await page.screenshot({
      fullPage: true,
      path: path.join(artifacts, "tracklist-refresh.png"),
    });
    steps.push(
      "a ready Tracklist refreshes, keeps its Cues while pending, and stays ready when the scan finds none"
    );

    await page.route(
      `**/sets/${saved.id}/tracklist`,
      (route) => route.fulfill({ body: "unavailable", status: 503 }),
      { times: 1 }
    );
    await page.reload();
    await page.getByRole("button", { name: "Try again" }).click();
    await list.getByRole("listitem").first().waitFor();
    steps.push(
      "a failed Tracklist load can be retried without requesting a new analysis"
    );

    execFileSync("bun", [
      "-e",
      `import { Database } from "bun:sqlite";
       const db = new Database(process.argv[1]);
       db.query("UPDATE sets SET tracklist_state = 'failed' WHERE id = ?").run(process.argv[2]);
       db.query("DELETE FROM set_cues WHERE set_id = ?").run(process.argv[2]);
       db.close();`,
      path.join(dataDirectory, "library.sqlite"),
      saved.id,
    ]);
    await page.reload();
    const retry = page.getByRole("button", { name: "Refresh tracklist" });
    const retried = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/sets/${saved.id}/tracklist/retry`) &&
        response.request().method() === "POST"
    );
    await retry.click();
    await page.getByText("Tracklist unavailable.").waitFor();
    await page.screenshot({
      fullPage: true,
      path: path.join(artifacts, "tracklist-failed.png"),
    });
    await retry.click();
    const response = await retried;
    assert.equal(response.status(), 200);
    // Without a description or Versos, the refresh answers that the Set has no Tracklist.
    await page.getByText("No tracklist found.").waitFor();
    await page.getByRole("button", { name: "Refresh tracklist" }).waitFor();
    await page.screenshot({
      fullPage: true,
      path: path.join(artifacts, "tracklist-none.png"),
    });
    steps.push(
      "a failed Tracklist refreshes to none, which offers the refresh again"
    );
  } finally {
    await browser.close();
  }
  await writeFile(
    path.join(artifacts, "result.json"),
    JSON.stringify({ ok: true, steps }, null, 2)
  );
  console.log(
    `tracklist journey passed: ${steps.length} steps, artifacts in ${artifacts}`
  );
} finally {
  api.kill();
  web.kill();
  await rm(dataDirectory, { force: true, recursive: true });
}
