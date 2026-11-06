// Join from a Join Link against a real Orbis API (PAL-1005 §2.3): the built web
// client in `vite preview` calls a throwaway server whose Group holds the Host.
// A link preview reads /join's tags with no JavaScript and never sees the
// passcode; a browser reads the passcode from the fragment, removes it, and
// joins; after a new passcode, the old link says it no longer works.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "playwright";

import {
  boxedCode,
  freePort,
  keyRecord,
  signInWithKey,
  startApi,
  startPreview,
  storedKey,
  textOf,
  VALID_GROUP_PASSCODE,
  waitFor,
} from "./helpers.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const artifacts = path.join(root, ".cache/web-join");
const ports = { device: await freePort(), web: await freePort() };
const apiUrl = `http://127.0.0.1:${ports.device}`;
const webUrl = `http://127.0.0.1:${ports.web}`;
const hostKey = randomBytes(24).toString("base64url");
const gone = "This invite link no longer works. Ask your Host for a new one.";
const steps = [];
const step = (name, detail = {}) => steps.push({ name, ...detail });

const dataDirectory = await mkdtemp(path.join(tmpdir(), "orbis-join-"));
await writeFile(
  path.join(dataDirectory, "devices.json"),
  JSON.stringify({
    keys: [keyRecord("join-key", "Join journey", "host", hostKey)],
    people: [{ id: "host", removed: false, username: "host" }],
    version: 2,
  })
);
const api = startApi({
  dataDirectory,
  origin: webUrl,
  port: ports.device,
});
const web = startPreview({ apiUrl, port: ports.web });

// The Group makes the passcode; the journey reads it like a Host would.
const newPasscode = async () => {
  const response = await fetch(`${apiUrl}/admin/passcode`, {
    headers: { authorization: `Bearer ${hostKey}` },
    method: "POST",
  });
  assert.equal(response.status, 200);
  const { passcode } = await response.json();
  assert.match(passcode, VALID_GROUP_PASSCODE);
  return passcode;
};

// The content of the meta tag named `property`, whatever order its attributes
// come in.
const metaContent = (html, property) =>
  html
    .match(/<meta [^>]*>/gu)
    ?.find((tag) =>
      new RegExp(`(?:property|name)="${property}"`, "u").test(tag)
    )
    ?.match(/content="(?<content>[^"]*)"/u)?.groups?.content;

// A PNG's width is the first field of its IHDR chunk, after the 8-byte
// signature and the chunk's length and type.
const pngWidth = (bytes) => Buffer.from(bytes).readUInt32BE(16);

// A fresh document each time: a goto that changes only the fragment would not
// reload the page.
const openLink = async (page, passcode) => {
  await page.goto("about:blank");
  await page.goto(`${webUrl}/join#${passcode}`);
};

try {
  await Promise.all([waitFor(`${apiUrl}/health`, api), waitFor(webUrl, web)]);
  await mkdir(artifacts, { recursive: true });
  const passcode = await newPasscode();

  // (a) What a link preview reads: the server's HTML, with no JavaScript run.
  const served = await fetch(`${webUrl}/join`);
  const html = await served.text();
  assert.equal(served.status, 200);
  assert.equal(metaContent(html, "og:title"), "Join the Orbis Group");
  assert.equal(metaContent(html, "og:site_name"), "Orbis");
  assert.equal(metaContent(html, "og:url"), "https://orbis.p11a.xyz/join");
  assert.equal(metaContent(html, "twitter:card"), "summary_large_image");
  const image = metaContent(html, "og:image") ?? "";
  assert.match(image, /^https:\/\/orbis\.p11a\.xyz\/\S+\.png$/u);
  assert.equal(metaContent(html, "og:image:type"), "image/png");
  assert.equal(metaContent(html, "og:image:width"), "1200");
  assert.equal(metaContent(html, "og:image:height"), "630");
  assert.match(html, /Install Orbis first/u);
  assert.ok(!html.includes(passcode), "the HTML must not hold the passcode");
  // The tag names production; this build serves the same file at that path.
  const picture = await fetch(`${webUrl}${new URL(image).pathname}`);
  const pictureBytes = await picture.arrayBuffer();
  assert.equal(picture.status, 200);
  assert.equal(picture.headers.get("content-type"), "image/png");
  const width = pngWidth(pictureBytes);
  assert.ok(width >= 900, `the preview image is ${width} px wide`);
  await writeFile(path.join(artifacts, "join.html"), html);
  step("the server's /join HTML has the preview tags and no passcode", {
    image,
    imageWidth: width,
    title: metaContent(html, "og:title"),
  });

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const violations = [];
    await page.exposeFunction("reportViolation", (text) =>
      violations.push(text)
    );
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (event) => {
        window.reportViolation(
          `${event.violatedDirective} ${event.blockedURI}`
        );
      });
    });
    const requests = [];
    page.on("request", (request) =>
      requests.push({
        body: request.postData() ?? "",
        method: request.method(),
        url: request.url(),
      })
    );
    const joinForm = page.getByRole("form", { name: "Join on the web" });

    // (b) The link fills the passcode, leaves the address bar, and joins.
    await page.goto(`${webUrl}/join#${passcode.toLowerCase()}`);
    await page.getByRole("heading", { name: "Join the Orbis Group" }).waitFor();
    await joinForm.getByLabel("Username").waitFor();
    assert.equal(page.url(), `${webUrl}/join`);
    assert.equal(
      await boxedCode(joinForm),
      passcode,
      "the link fills the passcode"
    );
    await page.getByText("Install Orbis first").waitFor();
    await page.screenshot({ path: path.join(artifacts, "join-link.png") });
    step("the link fills the passcode and leaves no # in the address", {
      url: page.url(),
    });

    await joinForm.getByLabel("Username").fill("friend");
    await joinForm.getByRole("button", { name: "Join on the Web" }).click();
    await page.getByRole("heading", { name: "Library" }).waitFor();
    assert.ok(await storedKey(page), "joining stores the new key");
    await page.screenshot({ path: path.join(artifacts, "join-joined.png") });
    const people = await fetch(`${apiUrl}/admin/people`, {
      headers: { authorization: `Bearer ${hostKey}` },
    });
    const { people: members } = await people.json();
    assert.ok(members.some((member) => member.username === "friend"));
    step("joining on the web reaches the signed-in app as friend");

    const lower = passcode.toLowerCase();
    const inUrl = requests.filter(({ url }) =>
      url.toLowerCase().includes(lower)
    );
    assert.deepEqual(inUrl, [], "no request URL carries the passcode");
    const inBody = requests.filter(({ body }) => body.includes(passcode));
    assert.deepEqual(
      inBody.map(({ method, url }) => `${method} ${new URL(url).pathname}`),
      ["POST /sign-in/join"],
      "only the join's body carries the passcode"
    );
    await writeFile(
      path.join(artifacts, "requests.json"),
      `${JSON.stringify(
        requests.map(({ method, url }) => ({ method, url })),
        null,
        2
      )}\n`
    );
    step("no request URL carries the passcode; only the join's body does", {
      requests: requests.length,
    });

    // (c) A new passcode stops the old link working.
    const replaced = await newPasscode();
    assert.notEqual(replaced, passcode);
    const stranger = await browser.newContext();
    const late = await stranger.newPage();
    await openLink(late, passcode);
    const lateForm = late.getByRole("form", { name: "Join on the web" });
    await lateForm.getByLabel("Username").fill("latecomer");
    await lateForm.getByRole("button", { name: "Join on the Web" }).click();
    assert.equal(await textOf(lateForm.getByRole("alert")), gone);
    assert.equal(late.url(), `${webUrl}/join`);
    assert.equal(await storedKey(late), null);
    await late.screenshot({ path: path.join(artifacts, "join-old-link.png") });
    await stranger.close();
    step("after a new passcode, the old link says it no longer works");

    // (d) A signed-in browser gets no join form, so it keeps its Person's key.
    const member = await browser.newContext();
    const signedIn = await member.newPage();
    await signInWithKey(signedIn, webUrl, hostKey);
    await openLink(signedIn, replaced);
    await signedIn
      .getByText("You are already signed in as host.", { exact: true })
      .waitFor();
    assert.equal(signedIn.url(), `${webUrl}/join`);
    assert.equal(
      await signedIn.getByRole("form", { name: "Join on the web" }).count(),
      0,
      "a signed-in browser gets no join form"
    );
    assert.equal(await storedKey(signedIn), hostKey);
    await signedIn.screenshot({
      path: path.join(artifacts, "join-signed-in.png"),
    });
    await member.close();
    step("a signed-in browser is told so and keeps its key");

    assert.deepEqual(violations, []);
    step("no Content Security Policy violations");
  } finally {
    await browser.close();
  }
  await writeFile(
    path.join(artifacts, "result.json"),
    `${JSON.stringify({ apiUrl, steps, webUrl }, null, 2)}\n`
  );
  console.log(
    `join journey passed: ${steps.length} steps, artifacts in ${artifacts}`
  );
} finally {
  api.kill("SIGTERM");
  web.kill("SIGTERM");
  await rm(dataDirectory, { force: true, recursive: true });
}
