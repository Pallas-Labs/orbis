// Join with the Group Passcode and sign in with a code against a real Orbis API:
// the built web client in `vite preview` calls a throwaway server whose Group
// holds the Host with one daily key.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import { chromium } from "playwright";

import {
  answerTo,
  clearCode,
  boxedCode,
  boxGroups,
  keyRecord,
  paste,
  signInWithKey,
  storedKey,
  textOf,
  waitFor,
} from "./helpers.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const artifacts = path.join(root, ".cache/web-sign-in");
const devicePort = 4421;
const webPort = 3321;
const apiUrl = `http://127.0.0.1:${devicePort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const hostKey = randomBytes(24).toString("base64url");
let passcode = "";

// The Group makes the passcode; the journey reads it like a Host would.
const openJoining = async () => {
  const response = await fetch(`${apiUrl}/admin/passcode`, {
    headers: { authorization: `Bearer ${hostKey}` },
    method: "POST",
  });
  ({ passcode } = await response.json());
  return response.status;
};

// A wrong guess from outside the browser, from the same address as the page.
const guessCode = () =>
  fetch(`${apiUrl}/sign-in/code`, {
    body: JSON.stringify({ code: "ZZZZZZZZ", label: "Guessing" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

const dataDirectory = await mkdtemp(path.join(tmpdir(), "orbis-sign-in-"));
await writeFile(
  path.join(dataDirectory, "devices.json"),
  JSON.stringify({
    keys: [keyRecord("journey-key", "Sign-in journey", "host", hostKey)],
    people: [{ id: "host", removed: false, username: "host" }],
    version: 2,
  })
);
const startApi = () =>
  spawn("bun", ["apps/web/e2e/api-server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      ORBIS_DATA_DIR: dataDirectory,
      ORBIS_FIXTURE_ORIGIN: webUrl,
      ORBIS_FIXTURE_PORT: String(devicePort),
    },
    stdio: "ignore",
  });
let api = startApi();
const web = spawn(
  "bun",
  [
    "x",
    "vite",
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    String(webPort),
    "--strictPort",
  ],
  {
    cwd: path.join(root, "apps/web"),
    env: { ...process.env, ORBIS_API_URL: apiUrl },
    stdio: "ignore",
  }
);

const steps = [];
const step = (name, detail = {}) => steps.push({ name, ...detail });
try {
  await Promise.all([waitFor(`${apiUrl}/health`), waitFor(webUrl)]);
  await mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      permissions: ["clipboard-read", "clipboard-write"],
    });
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
    const shot = (name) =>
      page.screenshot({ path: path.join(artifacts, `${name}.png`) });
    const codeForm = page.getByRole("form", {
      name: "Sign in with a Sign-in Code",
    });
    const codeField = codeForm.getByLabel("Sign-in Code");
    const joinForm = page.getByRole("form", {
      name: "Join with the Group Passcode",
    });
    const passcodeField = joinForm.getByLabel("Group Passcode");
    // A full passcode submits the form by itself once the username is there.
    const join = (username, keys) =>
      answerTo(page, "/sign-in/join", async () => {
        await joinForm.getByLabel("Username").fill(username);
        await clearCode(passcodeField);
        await passcodeField.pressSequentially(keys);
      });
    const typeCode = (keys) =>
      answerTo(page, "/sign-in/code", async () => {
        await clearCode(codeField);
        await codeField.pressSequentially(keys);
      });
    const expectRefusal = async (form, answer, status) => {
      assert.equal(answer.status, status);
      assert.notEqual(answer.body.message ?? "", "");
      assert.equal(await textOf(form.getByRole("alert")), answer.body.message);
      assert.equal(await storedKey(page), null);
    };
    const sentTo = (pathname) => {
      const sent = { value: false };
      const watch = (request) => {
        sent.value ||= new URL(request.url()).pathname === pathname;
      };
      page.on("request", watch);
      return {
        stop: () => {
          page.off("request", watch);
          return sent.value;
        },
      };
    };

    await page.goto(webUrl);
    await page.getByRole("heading", { name: "Sign in to Orbis" }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/sign-in");
    await codeField.waitFor();
    await passcodeField.waitFor();
    assert.equal(await boxGroups(codeForm), 2);
    assert.equal(await boxGroups(joinForm), 3);
    assert.equal(await codeField.getAttribute("autocomplete"), "one-time-code");
    assert.equal(await codeField.getAttribute("inputmode"), "text");
    await shot("signed-out");
    step(
      "a signed-out visit to / shows a Sign-in Code field of 4+4 boxes and a Group Passcode field of 4+4+4 boxes"
    );

    const closed = await answerTo(page, "/sign-in/join", async () => {
      await joinForm.getByLabel("Username").fill("bob");
      await passcodeField.pressSequentially("zzzz");
      await joinForm.getByRole("button", { name: "Join" }).click();
    });
    await expectRefusal(joinForm, closed, 403);
    await shot("join-closed");
    step("joining while the Host has no passcode shows the API's refusal", {
      message: closed.body.message,
    });

    assert.equal(await openJoining(), 200);
    const wrong = await join("bob", "zzzz-zzzz-zzzz");
    assert.equal(wrong.payload.passcode, "ZZZZZZZZZZZZ");
    await expectRefusal(joinForm, wrong, 403);
    step(
      "a wrong passcode typed with dashes fills 12 boxes, submits by itself, and shows the API's refusal",
      { message: wrong.body.message }
    );

    const taken = await join("host", passcode.toLowerCase());
    assert.equal(taken.payload.passcode, passcode);
    await expectRefusal(joinForm, taken, 409);
    step("a taken username shows the API's refusal", {
      message: taken.body.message,
    });

    await page.reload();
    await joinForm.getByLabel("Username").fill("");
    await clearCode(passcodeField);
    const joinLink = `https://orbis.p11a.xyz/join#${passcode}`;
    const linkWatch = sentTo("/sign-in/join");
    await paste(passcodeField, joinLink);
    assert.equal(await passcodeField.inputValue(), passcode);
    assert.equal(await boxedCode(joinForm), passcode);
    assert.equal(await joinForm.getByRole("alert").count(), 0);
    assert.equal(linkWatch.stop(), false);
    await shot("join-link-pasted");
    step(
      "a pasted Join Link keeps only the passcode, and a full passcode before the username neither submits nor complains",
      { joinLink }
    );

    const joined = await answerTo(page, "/sign-in/join", async () => {
      await joinForm.getByLabel("Username").fill("bob");
      await joinForm.getByRole("button", { name: "Join" }).click();
    });
    assert.equal(joined.status, 201);
    assert.equal(joined.payload.passcode, passcode);
    await page.getByRole("heading", { name: "Library" }).waitFor();
    await page.getByText("Signed in as bob").waitFor();
    assert.equal(await storedKey(page), joined.body.key);
    assert.match(joined.payload.label, /^Chrome on /u);
    await page.reload();
    await page.getByRole("heading", { name: "Library" }).waitFor();
    await shot("joined");
    step(
      "the passcode from the Join Link creates bob, stores the returned key, and survives a reload",
      { label: joined.payload.label }
    );

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("heading", { name: "Sign in to Orbis" }).waitFor();
    assert.equal(await storedKey(page), null);
    step("sign out clears the key");

    const shortWatch = sentTo("/sign-in/code");
    await codeField.pressSequentially("a- O0I1Loilb");
    assert.equal(await codeField.inputValue(), "AB");
    assert.equal(await boxedCode(codeForm), "AB");
    await shot("rejected-characters");
    await codeForm.getByRole("button", { name: "Sign in" }).click();
    await codeForm
      .getByRole("alert")
      .getByText("Enter the eight-character code")
      .waitFor();
    assert.equal(shortWatch.stop(), false);
    step(
      "a dash, a space, O, 0, I, 1, and L in either case enter nothing, and a short code is refused without calling the API",
      { kept: "AB", typed: "a- O0I1Loilb" }
    );

    const typed = await typeCode("zzzz-zzzz");
    assert.equal(typed.payload.code, "ZZZZZZZZ");
    assert.equal(await boxedCode(codeForm), "ZZZZZZZZ");
    await expectRefusal(codeForm, typed, 404);
    await shot("typed-code");
    step(
      "typing zzzz-zzzz fills 8 boxes with ZZZZZZZZ and submits by itself, and the API's refusal shows",
      { message: typed.body.message }
    );

    await clearCode(codeField);
    const pasted = await answerTo(page, "/sign-in/code", () =>
      paste(codeField, "abcd-efgh")
    );
    assert.equal(pasted.payload.code, "ABCDEFGH");
    assert.equal(await boxedCode(codeForm), "ABCDEFGH");
    await expectRefusal(codeForm, pasted, 404);
    await shot("pasted-code");
    step(
      "pasting abcd-efgh fills 8 boxes with ABCDEFGH and submits by itself",
      { message: pasted.body.message }
    );

    const repasted = await answerTo(page, "/sign-in/code", () =>
      paste(codeField, "wxyz-wxyz")
    );
    assert.equal(repasted.payload.code, "WXYZWXYZ");
    assert.equal(await boxedCode(codeForm), "WXYZWXYZ");
    await expectRefusal(codeForm, repasted, 404);
    await shot("repasted-code");
    step(
      "pasting a new code over a full field replaces every box and submits again",
      { message: repasted.body.message }
    );

    await page.evaluate(() => localStorage.setItem("orbis.apiKey", "revoked"));
    await page.goto(webUrl);
    await page
      .getByRole("alert")
      .getByText("Your saved key no longer works.")
      .waitFor();
    assert.equal(await storedKey(page), null);
    step("a saved key the API rejects is dropped with a notice");

    await signInWithKey(page, webUrl, hostKey);
    await page.getByRole("heading", { name: "Library" }).waitFor();
    api.kill("SIGTERM");
    await setTimeout(500);
    await page.reload();
    await page
      .getByRole("alert")
      .getByText("Orbis could not be reached.")
      .waitFor();
    assert.equal(await storedKey(page), hostKey);
    await shot("unreachable");
    step("an unreachable API keeps the key and says why");

    api = startApi();
    await waitFor(`${apiUrl}/health`);
    await page.getByRole("button", { name: "Try again" }).click();
    await page.getByRole("heading", { name: "Library" }).waitFor();
    step("Try again signs back in once the API is back");

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("heading", { name: "Sign in to Orbis" }).waitFor();
    for (let attempt = 0; attempt < 25; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- attempts run in order; each counts toward the limit under test
      await guessCode();
    }
    const limited = await typeCode("zzzzzzzz");
    await expectRefusal(codeForm, limited, 429);
    step("after many wrong guesses the API's rate-limit message shows", {
      message: limited.body.message,
    });

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
    `sign-in journey passed: ${steps.length} steps, artifacts in ${artifacts}`
  );
} finally {
  api.kill("SIGTERM");
  web.kill("SIGTERM");
  await rm(dataDirectory, { force: true, recursive: true });
}
