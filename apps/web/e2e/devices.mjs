// List, add, and revoke devices against a real Orbis API: the built web client in
// `vite preview` calls a throwaway server whose trust store holds two of the Host's
// daily keys, a key stored as admin, and a key for a second Person. A second browser
// signs in with a Sign-in Code from the Devices page.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "playwright";

import {
  answerTo,
  boxedCode,
  boxGroups,
  clearCode,
  freePort,
  keyRecord,
  paste,
  signInWithKey,
  startApi,
  startPreview,
  storedKey,
  textOf,
  VALID_SIGN_IN_CODE,
  waitFor,
} from "./helpers.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const artifacts = path.join(root, ".cache/web-devices");
const devicePort = await freePort();
const webPort = await freePort();
const apiUrl = `http://127.0.0.1:${devicePort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const tokens = {
  admin: randomBytes(24).toString("base64url"),
  alice: randomBytes(24).toString("base64url"),
  laptop: randomBytes(24).toString("base64url"),
  phone: randomBytes(24).toString("base64url"),
};

const dataDirectory = await mkdtemp(path.join(tmpdir(), "orbis-devices-"));
await writeFile(
  path.join(dataDirectory, "devices.json"),
  JSON.stringify({
    keys: [
      keyRecord("laptop-key", "Laptop", "host", tokens.laptop),
      keyRecord("phone-key", "Phone", "host", tokens.phone),
      keyRecord("admin-key", "Recovery", "host", tokens.admin, "admin"),
      keyRecord("alice-key", "Alice phone", "alice", tokens.alice),
    ],
    people: [
      { id: "host", removed: false, username: "host" },
      { id: "alice", removed: false, username: "alice" },
    ],
    version: 2,
  })
);
const api = startApi({
  dataDirectory,
  origin: webUrl,
  port: devicePort,
});
const web = startPreview({ apiUrl, port: webPort });

// A direct call with no Origin, the way a native client would make it.
const meStatus = async (token) => {
  const response = await fetch(`${apiUrl}/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return response.status;
};

const steps = [];
const step = (name, detail = {}) => steps.push({ name, ...detail });
try {
  await Promise.all([waitFor(`${apiUrl}/health`, api), waitFor(webUrl, web)]);
  await mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const clipboard = { permissions: ["clipboard-read", "clipboard-write"] };
    const page = await browser.newPage(clipboard);
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
    const deviceList = page.getByRole("list", { name: "Your devices" });
    const deviceNames = () => deviceList.getByRole("heading").allTextContents();

    await signInWithKey(page, webUrl, tokens.laptop);
    await page.getByRole("heading", { name: "Library" }).waitFor();
    step("the Laptop key signs in");

    await page.getByRole("link", { name: "Devices" }).click();
    await page.getByRole("heading", { name: "Devices" }).waitFor();
    await deviceList.getByRole("heading", { name: "Phone" }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/devices");
    const listed = await deviceNames();
    assert.deepEqual(listed.toSorted(), ["Laptop", "Phone", "Recovery"]);
    const laptopRow = deviceList
      .getByRole("listitem")
      .filter({ has: page.getByRole("heading", { name: "Laptop" }) });
    await laptopRow.getByText("This device").waitFor();
    assert.equal(await deviceList.getByText("This device").count(), 1);
    await page.screenshot({ path: path.join(artifacts, "devices.png") });
    step(
      "Devices lists Laptop (This device), Phone, and Recovery, a key stored as admin, not alice's key"
    );

    await page.getByRole("button", { name: "Revoke Phone" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("heading", { name: "Revoke Phone?" }).waitFor();
    await page.screenshot({ path: path.join(artifacts, "confirm-phone.png") });
    await page.route("**/me/devices/*", (route) =>
      route.fulfill({ body: "{}", status: 500 })
    );
    await dialog.getByRole("button", { name: "Revoke" }).click();
    await dialog.getByRole("alert").getByText("Try again.").waitFor();
    assert.equal(
      await dialog.getByRole("button", { name: "Revoke" }).isEnabled(),
      true
    );
    await page.screenshot({ path: path.join(artifacts, "revoke-failed.png") });
    await page.unroute("**/me/devices/*");
    step("a failed revoke keeps the dialog open and shows why inside it");

    await dialog.getByRole("button", { name: "Revoke" }).click();
    await dialog.waitFor({ state: "detached" });
    await deviceList
      .getByRole("heading", { name: "Phone" })
      .waitFor({ state: "detached" });
    const afterPhone = await deviceNames();
    assert.deepEqual(afterPhone.toSorted(), ["Laptop", "Recovery"]);
    assert.equal(await meStatus(tokens.phone), 401);
    assert.equal(await meStatus(tokens.alice), 200);
    assert.equal(await meStatus(tokens.admin), 200);
    await page.screenshot({ path: path.join(artifacts, "phone-revoked.png") });
    step(
      "revoking Phone after confirming removes it, and the API refuses the Phone key"
    );

    const shownCode = page.getByRole("status", { name: "Your Sign-in Code" });
    await page.getByRole("button", { name: "Sign in another device" }).click();
    await shownCode.waitFor();
    const firstCode = await boxedCode(shownCode);
    assert.match(firstCode, VALID_SIGN_IN_CODE);
    await page.getByText("Works once, until").waitFor();
    await page.getByRole("button", { name: "Get a new code" }).click();
    await page.waitForFunction(
      (previous) =>
        [
          ...document.querySelectorAll(
            '[aria-label="Your Sign-in Code"] [data-slot="input-otp-slot"]'
          ),
        ]
          .map((box) => box.textContent)
          .join("") !== previous,
      firstCode
    );
    const code = await boxedCode(shownCode);
    assert.match(code, VALID_SIGN_IN_CODE);
    assert.equal(await boxGroups(shownCode), 2);
    assert.doesNotMatch(await shownCode.textContent(), /-/u);
    assert.equal(
      await textOf(shownCode.locator(".sr-only")),
      `${code.slice(0, 4)}, ${code.slice(4)}`.replaceAll(/(?<=\w)(?=\w)/gu, " ")
    );
    await page.getByRole("button", { name: "Copy code" }).click();
    await page.getByRole("button", { name: "Copied" }).waitFor();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      code
    );
    await page.screenshot({ path: path.join(artifacts, "sign-in-code.png") });
    step(
      "Sign in another device shows a code in two groups of four boxes with no dash, read aloud one character at a time, Copy copies it, and Get a new code replaces it",
      { code }
    );

    const newDevice = await browser.newContext(clipboard);
    const other = await newDevice.newPage();
    await other.goto(webUrl);
    const codeForm = other.getByRole("form", {
      name: "Sign in with a Sign-in Code",
    });
    const dashed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();
    const redeemed = await answerTo(other, "/sign-in/code", () =>
      paste(codeForm.getByLabel("Sign-in Code"), dashed)
    );
    assert.equal(redeemed.payload.code, code);
    await other.getByRole("heading", { name: "Library" }).waitFor();
    await other.getByText("Signed in as host").waitFor();
    assert.notEqual(await storedKey(other), null);
    await other.screenshot({ path: path.join(artifacts, "redeemed.png") });
    await page.reload();
    await deviceList.getByRole("heading", { name: /^Chrome on /u }).waitFor();
    const namesAfterRedeem = await deviceNames();
    assert.equal(namesAfterRedeem.length, 3);
    step(
      "another browser pastes the code in lower case with a dash, signs in as host without pressing Sign in, and appears on Devices under its browser name",
      { pasted: dashed }
    );

    const thirdDevice = await browser.newContext();
    const third = await thirdDevice.newPage();
    await third.goto(webUrl);
    const thirdForm = third.getByRole("form", {
      name: "Sign in with a Sign-in Code",
    });
    const thirdField = thirdForm.getByLabel("Sign-in Code");
    const reused = await answerTo(third, "/sign-in/code", () =>
      thirdField.pressSequentially(code)
    );
    assert.equal(reused.status, 404);
    assert.equal(
      await textOf(thirdForm.getByRole("alert")),
      reused.body.message
    );
    await clearCode(thirdField);
    const replaced = await answerTo(third, "/sign-in/code", () =>
      thirdField.pressSequentially(firstCode)
    );
    assert.equal(replaced.status, 404);
    await thirdDevice.close();
    await newDevice.close();
    step(
      "the used code and the code it replaced do not work, and the page shows why",
      { message: reused.body.message }
    );

    await page.getByRole("button", { name: "Revoke Laptop" }).click();
    await dialog.getByRole("heading", { name: "Revoke Laptop?" }).waitFor();
    await dialog.getByText("This is the device you are using.").waitFor();
    await page.screenshot({ path: path.join(artifacts, "confirm-laptop.png") });
    await dialog.getByRole("button", { name: "Revoke" }).click();
    await page.getByRole("heading", { name: "Sign in to Orbis" }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/sign-in");
    assert.equal(await storedKey(page), null);
    assert.equal(await meStatus(tokens.laptop), 401);
    await page.screenshot({ path: path.join(artifacts, "signed-out.png") });
    step(
      "revoking this device signs out, clears the key, and the API refuses the Laptop key"
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
    `devices journey passed: ${steps.length} steps, artifacts in ${artifacts}`
  );
} finally {
  api.kill("SIGTERM");
  web.kill("SIGTERM");
  await rm(dataDirectory, { force: true, recursive: true });
}
