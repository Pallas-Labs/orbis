// Approve a device from its /pair link against a real Orbis API (ADR 0022): the
// built web client in `vite preview` calls a throwaway server, a TV's Approval
// Request is started over HTTP, and the Host's browser approves it, cancels one,
// meets an unknown code, and a signed-out browser is asked to sign in.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "playwright";

import { keyRecord, signInWithKey, textOf, waitFor } from "./helpers.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const artifacts = path.join(root, ".cache/web-pair");
const ports = { device: 4561, web: 3461 };
const apiUrl = `http://127.0.0.1:${ports.device}`;
const webUrl = `http://127.0.0.1:${ports.web}`;
const hostKey = randomBytes(24).toString("base64url");
const expired = "This code has expired. Check the TV for a new one.";
const steps = [];
const step = (name, detail = {}) => steps.push({ name, ...detail });

const dataDirectory = await mkdtemp(path.join(tmpdir(), "orbis-pair-"));
await writeFile(
  path.join(dataDirectory, "devices.json"),
  JSON.stringify({
    keys: [keyRecord("pair-key", "Pair journey", "host", hostKey)],
    people: [{ id: "host", removed: false, username: "host" }],
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

// Direct calls with no Origin, the way the TV makes them.
const post = async (pathname, body, key) => {
  const headers = new Headers({ "content-type": "application/json" });
  if (key !== undefined) {
    headers.set("authorization", `Bearer ${key}`);
  }
  const response = await fetch(`${apiUrl}${pathname}`, {
    body: JSON.stringify(body),
    headers,
    method: "POST",
  });
  return { body: await response.json(), status: response.status };
};

const startRequest = async (label) => {
  const started = await post("/sign-in/requests", { label, platform: "tvOS" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.match(started.body.code, /^\d{6}$/u);
  return started.body;
};

// A fresh document each time: a goto that changes only the fragment would not reload the page.
const openLink = async (page, fragment) => {
  await page.goto("about:blank");
  await page.goto(`${webUrl}/pair#${fragment}`);
};

const spaced = (code) => `${code.slice(0, 3)} ${code.slice(3)}`;

try {
  await Promise.all([waitFor(`${apiUrl}/health`), waitFor(webUrl)]);
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
    ["/pair", "/join"]
  );
  step("apple-app-site-association names the app, /pair, and /join", {
    body: associationBody,
    contentType: association.headers.get("content-type"),
    status: association.status,
  });

  const living = await startRequest("Orbis on Living Room");
  step("a TV starts an Approval Request", { code: living.code });

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
    await signInWithKey(page, webUrl, hostKey);
    await page.getByRole("heading", { name: "Library" }).waitFor();

    await openLink(page, living.code);
    await page.getByRole("heading", { name: "Sign in Apple TV?" }).waitFor();
    assert.equal(page.url(), `${webUrl}/pair`);
    const asked = await textOf(page.getByText(/^Asked /u));
    assert.match(asked, /^Asked \d+ seconds? ago · code \d{3} \d{3}$/u);
    assert.ok(asked.endsWith(spaced(living.code)), asked);
    await page.getByText("Orbis on Living Room").waitFor();
    await page
      .getByText("Only sign in a TV that is in front of you.")
      .waitFor();
    await page.screenshot({ path: path.join(artifacts, "pair-sheet.png") });
    step("the link opens the approve card and leaves no code in the address", {
      asked,
      url: page.url(),
    });

    await page.getByRole("button", { name: "Sign In as host" }).click();
    await page
      .getByRole("heading", { name: "Apple TV is signed in." })
      .waitFor();
    await page.screenshot({ path: path.join(artifacts, "pair-approved.png") });
    const collected = await post("/sign-in/requests/wait", {
      secret: living.secret,
    });
    assert.equal(collected.status, 200);
    assert.equal(collected.body.status, "approved");
    assert.ok(collected.body.key);
    const me = await fetch(`${apiUrl}/me`, {
      headers: { authorization: `Bearer ${collected.body.key}` },
    });
    assert.equal(me.status, 200);
    const person = await me.json();
    assert.equal(person.username, "host");
    step("Sign In as host approves, and the TV's wait collects a host key");

    await page.getByRole("link", { name: "Open Devices" }).click();
    await page
      .getByRole("list", { name: "Your devices" })
      .getByRole("heading", { name: "Orbis on Living Room" })
      .waitFor();
    step("Devices lists Orbis on Living Room");

    const kitchen = await startRequest("Orbis on Kitchen");
    await openLink(page, kitchen.code);
    await page.getByRole("heading", { name: "Sign in Apple TV?" }).waitFor();
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("heading", { name: "Library" }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/");
    const stillWaiting = await post(
      "/me/sign-in-requests/find",
      { code: kitchen.code },
      hostKey
    );
    assert.equal(stillWaiting.status, 200);
    assert.equal(stillWaiting.body.label, "Orbis on Kitchen");
    step("Cancel goes home and leaves the request waiting", {
      code: kitchen.code,
    });

    let unknown = kitchen.code;
    while (unknown === kitchen.code) {
      unknown = String(randomInt(1_000_000)).padStart(6, "0");
    }
    await openLink(page, unknown);
    await page.getByRole("alert").getByText(expired).waitFor();
    assert.equal(page.url(), `${webUrl}/pair`);
    await page.screenshot({ path: path.join(artifacts, "pair-expired.png") });
    step("an unknown code says the code has expired", { code: unknown });

    await openLink(page, "48271");
    await page.getByRole("alert").getByText(expired).waitFor();
    step("a malformed fragment says the code has expired");

    const signedOut = await browser.newContext();
    const stranger = await signedOut.newPage();
    await openLink(stranger, kitchen.code);
    await stranger.getByText("Sign in to approve this device.").waitFor();
    await stranger
      .getByText("Or open this link on a device where you use Orbis.")
      .waitFor();
    assert.equal(stranger.url(), `${webUrl}/pair`);
    await stranger.screenshot({
      path: path.join(artifacts, "pair-signed-out.png"),
    });
    await stranger.getByRole("link", { name: "Sign in" }).click();
    await stranger.getByRole("heading", { name: "Sign in to Orbis" }).waitFor();
    await signedOut.close();
    step(
      "a signed-out browser is asked to sign in, with no code in the address"
    );

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
    `pair journey passed: ${steps.length} steps, artifacts in ${artifacts}`
  );
} finally {
  api.kill("SIGTERM");
  web.kill("SIGTERM");
  await rm(dataDirectory, { force: true, recursive: true });
}
