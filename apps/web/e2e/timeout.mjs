// Every call from the web client waits a bounded time for the API's response
// (`RESPONSE_TIMEOUT` in `src/lib/orbis.ts`, 45 s). The page's clock is fake,
// so the journey moves time forward instead of waiting.
//
// 1. Against an API that takes the sign-in request and never answers, the form
//    still waits at 44 s, and at 46 s it shows the unreachable message and the
//    browser has closed the request.
// 2. Against the real API, the live `/events` stream stays open long after the
//    timeout: the bound ends when the response arrives, not when the stream does.
// 3. Signing out still aborts that stream through the caller's own signal.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "playwright";

import {
  freePort,
  keyRecord,
  signInWithKey,
  startApi,
  startPreview,
  textOf,
  waitFor,
  waitUntil,
} from "./helpers.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const artifacts = path.join(root, ".cache/web-timeout");
const devicePort = await freePort();
const silentWebPort = await freePort();
const webPort = await freePort();
const apiUrl = `http://127.0.0.1:${devicePort}`;
const silentWebUrl = `http://127.0.0.1:${silentWebPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const hostKey = randomBytes(24).toString("base64url");

const UNREACHABLE =
  "Orbis could not be reached. If your browser asks to access devices on your local network, allow it and try again.";

// An API that accepts the connection and the CORS preflight, then never
// answers the request itself. It records each held request and whether the
// browser closed it.
const held = [];
const silentApi = createServer((request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-headers": "content-type, authorization",
      "access-control-allow-methods": "GET, POST",
      "access-control-allow-origin": silentWebUrl,
    });
    response.end();
    return;
  }
  const entry = { closed: false, method: request.method, url: request.url };
  held.push(entry);
  response.on("close", () => {
    entry.closed = true;
  });
});
silentApi.listen(0, "127.0.0.1");
await once(silentApi, "listening");
const silentApiUrl = `http://127.0.0.1:${silentApi.address().port}`;

const dataDirectory = await mkdtemp(path.join(tmpdir(), "orbis-timeout-"));
await writeFile(
  path.join(dataDirectory, "devices.json"),
  JSON.stringify({
    keys: [keyRecord("journey-key", "Timeout journey", "host", hostKey)],
    people: [{ id: "host", removed: false, username: "host" }],
    version: 2,
  })
);
const api = startApi({ dataDirectory, origin: webUrl, port: devicePort });
const silentWeb = startPreview({ apiUrl: silentApiUrl, port: silentWebPort });
const web = startPreview({ apiUrl, port: webPort });

const steps = [];
const step = (name, detail = {}) => steps.push({ name, ...detail });
try {
  await Promise.all([
    waitFor(`${apiUrl}/health`, api),
    waitFor(silentWebUrl, silentWeb),
    waitFor(webUrl, web),
  ]);
  await rm(artifacts, { force: true, recursive: true });
  await mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    // 1. A request the API never answers ends as unreachable.
    const page = await browser.newPage();
    await page.clock.install();
    await page.goto(`${silentWebUrl}/sign-in`);
    const form = page.getByRole("form", {
      name: "Sign in with a Sign-in Code",
    });
    await form.getByLabel("Sign-in Code").pressSequentially("ABCDEFGH");
    await waitUntil(
      () => held.some((entry) => entry.url === "/sign-in/code"),
      "the sign-in request never reached the silent API"
    );
    const request = held.find((entry) => entry.url === "/sign-in/code");
    step("held the sign-in request", {
      method: request.method,
      url: request.url,
    });

    await page.clock.fastForward("00:44");
    const pending = await textOf(form.getByRole("button"));
    assert.equal(pending, "Signing in…");
    assert.equal(await form.getByRole("alert").count(), 0);
    assert.equal(request.closed, false);
    await page.screenshot({
      path: path.join(artifacts, "1-waiting-at-44s.png"),
    });
    step("still waiting at 44 s", { requestClosed: request.closed });

    await page.clock.fastForward("00:02");
    await form.getByRole("alert").waitFor({ timeout: 10_000 });
    assert.equal(await textOf(form.getByRole("alert")), UNREACHABLE);
    await waitUntil(
      () => request.closed,
      "the browser kept the timed-out request open"
    );
    await page.screenshot({
      path: path.join(artifacts, "2-unreachable-at-46s.png"),
    });
    step("unreachable at 46 s", {
      alert: UNREACHABLE,
      requestClosed: request.closed,
    });
    await page.close();

    // 2. The live stream outlives the timeout.
    const app = await browser.newPage();
    await app.clock.install();
    const opened = [];
    const failed = [];
    app.on("request", (sent) => {
      if (new URL(sent.url()).pathname === "/events") {
        opened.push(sent.url());
      }
    });
    app.on("requestfailed", (sent) => {
      failed.push(`${sent.url()} ${sent.failure()?.errorText}`);
    });
    // The timeout covers the wait for the stream's response, so time moves only
    // once the response has arrived.
    const streaming = app.waitForResponse(
      (answer) => new URL(answer.url()).pathname === "/events"
    );
    await signInWithKey(app, webUrl, hostKey);
    await app.getByText("Signed in as host").waitFor();
    const stream = await streaming;
    assert.equal(stream.status(), 200);
    await app.clock.fastForward("03:00");
    // Give a reconnect, if one were coming, real time to show up.
    await app.waitForTimeout(2000);
    assert.deepEqual(
      { failed, opened: opened.length },
      { failed: [], opened: 1 }
    );
    await app.screenshot({
      path: path.join(artifacts, "3-stream-open-after-3min.png"),
    });
    step("events stream open after 3 min", {
      eventsRequests: opened.length,
      failed,
    });

    // 3. The caller's own signal still cancels: signing out unmounts the live
    //    stream, which aborts its controller.
    await app.getByRole("button", { name: "Sign out" }).click();
    await app.getByRole("heading", { name: "Sign in to Orbis" }).waitFor();
    await waitUntil(
      () => failed.some((line) => line.includes("/events")),
      "signing out left the /events request open"
    );
    assert.deepEqual(failed, [`${apiUrl}/events?changes=1 net::ERR_ABORTED`]);
    step("sign out aborts the events stream", { failed });
  } finally {
    await browser.close();
  }
  await writeFile(
    path.join(artifacts, "timeout.json"),
    `${JSON.stringify({ apiUrl, silentApiUrl, steps }, null, 2)}\n`
  );
  console.log(
    `timeout journey passed: ${steps.length} steps, artifacts in ${artifacts}`
  );
} finally {
  silentApi.closeAllConnections();
  silentApi.close();
  api.kill("SIGTERM");
  silentWeb.kill("SIGTERM");
  web.kill("SIGTERM");
  await rm(dataDirectory, { force: true, recursive: true });
}
