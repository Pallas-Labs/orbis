import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";

export const waitFor = async (url) => {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- polling loop: each attempt waits for the previous one
      await fetch(url);
      return;
    } catch {
      // Not listening yet.
    }
    // eslint-disable-next-line no-await-in-loop -- polling loop: each attempt waits for the previous one
    await setTimeout(100);
  }
  throw new Error(`${url} did not start`);
};

/** A key as the trust store's `devices.json` seeds it. */
export const keyRecord = (id, label, personId, token, scope = "daily") => ({
  addedAt: new Date().toISOString(),
  id,
  label,
  lastUsedAt: null,
  personId,
  scope,
  tokenHash: createHash("sha256").update(token).digest("hex"),
});

// Journeys that are not about signing in start with a key already in the
// browser, stored where the sign-in page stores the key the API returns.
export const signInWithKey = async (page, webUrl, key) => {
  await page.goto(`${webUrl}/sign-in`);
  await page.evaluate(
    (value) => localStorage.setItem("orbis.apiKey", value),
    key
  );
  await page.goto(webUrl);
};

export const storedKey = (page) =>
  page.evaluate(() => localStorage.getItem("orbis.apiKey"));

export const textOf = async (locator) => {
  const text = await locator.textContent();
  return text.trim();
};

/**
 * Runs `act` and returns the API's answer to the POST to `pathname` that it
 * causes, so a step can compare the page with what the API said.
 */
export const answerTo = async (page, pathname, act) => {
  const answer = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === pathname &&
      response.request().method() === "POST"
  );
  await act();
  const response = await answer;
  return {
    body: await response.json(),
    payload: response.request().postDataJSON(),
    status: response.status(),
  };
};

/** Fills a form's fields by label, submits it, and returns the API's answer. */
export const submitForm = (form, pathname, fields) =>
  answerTo(form.page(), pathname, async () => {
    for (const [label, value] of Object.entries(fields)) {
      // eslint-disable-next-line no-await-in-loop -- cases run in order so a failure names the first bad one
      await form.getByLabel(label).fill(value);
    }
    await form.getByRole("button").click();
  });

export const VALID_SIGN_IN_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/u;
export const VALID_GROUP_PASSCODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/u;

/**
 * Pastes `text` into a field the way Ctrl+V does, through the real clipboard.
 * The browser context needs the clipboard permissions.
 */
export const paste = async (field, text) => {
  const page = field.page();
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await field.focus();
  await page.keyboard.press("ControlOrMeta+V");
};

/** Empties a code field with the keyboard, as a person would. */
export const clearCode = async (field) => {
  await field.press("ControlOrMeta+A");
  await field.press("Backspace");
};

/** The characters a code field or a shown code holds, read from its boxes. */
export const boxedCode = async (locator) => {
  const boxes = await locator
    .locator('[data-slot="input-otp-slot"]')
    .allTextContents();
  return boxes.join("");
};

/** How many groups of boxes a code field or a shown code has. */
export const boxGroups = (locator) =>
  locator.locator('[data-slot="input-otp-group"]').count();
