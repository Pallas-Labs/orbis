import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";

/**
 * Polls `url` until it answers, 150 attempts 100 ms apart. Recursive rather than
 * a loop, so each attempt is a separate await the journeys share instead of
 * copying.
 */
export const waitFor = (url) => {
  const poll = async (attemptsLeft) => {
    try {
      await fetch(url);
      return;
    } catch {
      // Not listening yet.
      if (attemptsLeft <= 1) {
        throw new Error(`${url} did not start`);
      }
    }
    await setTimeout(100);
    return poll(attemptsLeft - 1);
  };
  return poll(150);
};

/**
 * Polls `check` until it answers true, `attempts` times 200 ms apart, and
 * throws `message` when every attempt answered false.
 */
export const waitUntil = (check, message, attempts = 100) => {
  const poll = async (attemptsLeft) => {
    if (await check()) {
      return;
    }
    if (attemptsLeft <= 1) {
      throw new Error(message);
    }
    await setTimeout(200);
    return poll(attemptsLeft - 1);
  };
  return poll(attempts);
};

/**
 * Runs `run` once for each item, one at a time in the order given. A journey whose
 * steps build on each other depends on that order, and `no-await-in-loop` cannot
 * tell it apart from a loop that should run in parallel, so the sequencing lives
 * here rather than in a suppressed loop. A throwing step stops the rest, as a
 * `for … await` loop does.
 */
export const runInOrder = async (items, run) => {
  const iterator = items[Symbol.iterator]();
  const step = async (index) => {
    const next = iterator.next();
    if (next.done === true) {
      return;
    }
    await run(next.value, index);
    await step(index + 1);
  };
  await step(0);
};

/** `runInOrder` over the indexes from `0` to `count - 1`. */
export const runTimesInOrder = async (count, run) => {
  const indexes = Array.from({ length: count }, (_, index) => index);
  await runInOrder(indexes, run);
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
    await runInOrder(Object.entries(fields), async ([label, value]) => {
      await form.getByLabel(label).fill(value);
    });
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
