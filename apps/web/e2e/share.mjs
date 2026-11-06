// A real browser, API, and web server verify Orbis Links (ADR 0023): the
// apple-app-site-association file, the /s/:id redirect to the Group's page, and
// the Set page's Share menu copying the Orbis Link and the Source Link.
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
} from "./helpers.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const artifacts = path.join(root, ".cache/web-share");
const dataDirectory = await mkdtemp(path.join(tmpdir(), "orbis-share-web-"));
const ports = { device: await freePort(), web: await freePort() };
const apiUrl = `http://127.0.0.1:${ports.device}`;
const webUrl = `http://127.0.0.1:${ports.web}`;
const key = randomBytes(24).toString("base64url");
const sourceLink = "https://www.youtube.com/watch?v=abcdefghijk";
const steps = [];
const step = (name, detail = {}) => steps.push({ name, ...detail });

await writeFile(
  path.join(dataDirectory, "devices.json"),
  JSON.stringify({
    keys: [keyRecord("share-web-key", "Share web", "host", key)],
    people: [
      { autoDownload: false, id: "host", removed: false, username: "host" },
    ],
    version: 2,
  })
);

const api = startApi({
  dataDirectory,
  origin: webUrl,
  port: ports.device,
});
const web = startPreview({ apiUrl, port: ports.web });

try {
  await Promise.all([waitFor(`${apiUrl}/health`, api), waitFor(webUrl, web)]);
  await mkdir(artifacts, { recursive: true });

  const association = await fetch(
    `${webUrl}/.well-known/apple-app-site-association`,
    { redirect: "manual" }
  );
  const associationBody = await association.text();
  assert.equal(association.status, 200);
  assert.ok(
    association.headers.get("content-type")?.startsWith("application/json"),
    `apple-app-site-association content-type: ${association.headers.get("content-type")}`
  );
  const [detail] = JSON.parse(associationBody).applinks.details;
  assert.deepEqual(detail.appIDs, ["JR398S689Z.app.orbis.client"]);
  assert.deepEqual(
    detail.components.map((component) => component["/"]),
    ["/pair", "/join", "/s/*"]
  );
  step("apple-app-site-association names the app and /s/*", {
    body: associationBody,
    contentType: association.headers.get("content-type"),
    status: association.status,
  });

  const saved = await fetch(`${apiUrl}/sets`, {
    body: JSON.stringify({ title: "Share journey Set", url: sourceLink }),
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    method: "POST",
  }).then((response) => response.json());
  assert.ok(saved.id, `save answered ${JSON.stringify(saved)}`);

  const link = await fetch(`${webUrl}/s/${saved.id}`, { redirect: "manual" });
  assert.equal(link.status, 302);
  assert.equal(
    link.headers.get("location"),
    `${apiUrl}/share/sets/${saved.id}/page`
  );
  step("an Orbis Link redirects to the Group's page", {
    location: link.headers.get("location"),
    status: link.status,
  });

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
    await signInWithKey(page, webUrl, key);
    await page.goto(`${webUrl}/sets/${saved.id}`);
    await page.getByRole("heading", { name: "Share journey Set" }).waitFor();

    await page.getByRole("button", { name: "Share" }).click();
    const menu = page.getByRole("menu");
    await menu.waitFor();
    assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), [
      "Copy Orbis link",
      "Copy YouTube link",
    ]);
    await page.screenshot({
      fullPage: true,
      path: path.join(artifacts, "share-menu.png"),
    });
    await menu.getByRole("menuitem", { name: "Copy Orbis link" }).click();
    await page.getByRole("status").getByText("Copied the Orbis link").waitFor();
    assert.equal(await clipboard(), `${webUrl}/s/${saved.id}`);
    step("Copy Orbis link puts the Orbis Link on the clipboard", {
      clipboard: await clipboard(),
    });

    await page.getByRole("button", { name: "Share" }).click();
    await page.getByRole("menuitem", { name: "Copy YouTube link" }).click();
    await page
      .getByRole("status")
      .getByText("Copied the YouTube link")
      .waitFor();
    assert.equal(await clipboard(), sourceLink);
    await page.screenshot({
      fullPage: true,
      path: path.join(artifacts, "share-copied.png"),
    });
    step("Copy YouTube link puts the Source Link on the clipboard", {
      clipboard: await clipboard(),
    });
  } finally {
    await browser.close();
  }
  await writeFile(
    path.join(artifacts, "result.json"),
    JSON.stringify({ ok: true, steps }, null, 2)
  );
  console.log(
    `share journey passed: ${steps.length} steps, artifacts in ${artifacts}`
  );
} finally {
  api.kill();
  web.kill();
  await rm(dataDirectory, { force: true, recursive: true });
}
