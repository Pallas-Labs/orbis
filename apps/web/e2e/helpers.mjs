import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

const root = path.resolve(import.meta.dirname, "../../..");

/**
 * A port no process on this host listens on now, drawn from the OS. Two
 * checkouts can run the journeys at the same time, so no journey owns a fixed
 * port. A process can still take the port before the journey's server binds
 * it; the server then exits, and `waitFor` names the port and the cause. The OS
 * can hand out a port again once it is closed, so a journey never gets the same
 * port twice.
 */
const drawn = new Set();
export const freePort = async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  if (drawn.has(port)) {
    return freePort();
  }
  drawn.add(port);
  return port;
};

/**
 * Spawns a server the journey owns on `port`. `listening` resolves when the
 * process prints its own address on stdout, which it does only once it has
 * bound `port`. `exit` resolves, once the process has ended, to an error that
 * names the server, its exit code, the port, and the cause from its stderr.
 * A journey stops its own servers on purpose, so only `waitFor` treats the exit
 * as a failure.
 */
const startServer = (name, port, args, options) => {
  const child = spawn("bun", args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const address = `127.0.0.1:${port}`;
  let stdout = "";
  let stderr = "";
  const { promise: listening, resolve: heard } = Promise.withResolvers();
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-4000);
    if (stdout.includes(address)) {
      heard();
    }
  });
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4000);
  });
  const exit = (async () => {
    const [code, signal] = await once(child, "close");
    // Bun and vite both print the cause on a line that starts `error:`, then a stack.
    const lines = stderr.trim().split("\n");
    const cause =
      lines.findLast((line) => /^\s*error:/iu.test(line))?.trim() ??
      lines.slice(-5).join("\n");
    return new Error(
      `${name} exited ${code ?? signal} on port ${port}: ${cause || "(no stderr)"}`
    );
  })();
  return {
    exit,
    hasExited: () => child.exitCode !== null || child.signalCode !== null,
    kill: (signal) => child.kill(signal),
    listening,
    name,
    port,
  };
};

/** The journeys' Orbis API (`api-server.ts`) on `port`, allowing the web client at `origin`. */
export const startApi = ({ dataDirectory, origin, port }) =>
  startServer("api server", port, ["apps/web/e2e/api-server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      ORBIS_DATA_DIR: dataDirectory,
      ORBIS_FIXTURE_ORIGIN: origin,
      ORBIS_FIXTURE_PORT: String(port),
    },
  });

/** The built web client in `vite preview` on `port`, calling the API at `apiUrl`. */
export const startPreview = ({ apiUrl, port }) =>
  startServer(
    "vite preview",
    port,
    [
      "x",
      "vite",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: path.join(root, "apps/web"),
      env: { ...process.env, ORBIS_API_URL: apiUrl },
    }
  );

/**
 * How long a server may take to listen. `vite preview` needs about 1 s of CPU
 * to start, but on a host whose CPU quota other work fills, such as the 4 CPUs
 * every agent on Vanta shares, it took up to 15 s, and longer three times in
 * one run (PAL-2472). A server that fails to start exits, and `waitFor` reports
 * that at once, so only a server that hangs waits this long.
 */
const startLimitSeconds = 60;

/**
 * Waits until `server` says it listens on its port, then polls `url` until it
 * answers, 150 attempts 100 ms apart. An answer counts only while `server` still
 * runs, so another process on the same port never stands in for it: when
 * `server` exits first, `waitFor` throws `server`'s exit error. Recursive rather
 * than a loop, so each attempt is a separate await the journeys share instead
 * of copying.
 */
export const waitFor = async (url, server) => {
  const startup = async () => {
    await setTimeout(startLimitSeconds * 1000, undefined, { ref: false });
    return new Error(
      `${server.name} did not listen on port ${server.port} in ${startLimitSeconds} s`
    );
  };
  const failure = await Promise.race([
    server.listening,
    server.exit,
    startup(),
  ]);
  if (failure instanceof Error) {
    throw failure;
  }
  const poll = async (attemptsLeft) => {
    if (server.hasExited()) {
      throw await server.exit;
    }
    try {
      await fetch(url);
    } catch {
      // Not answering yet.
      if (attemptsLeft <= 1) {
        throw new Error(`${url} did not start`);
      }
      await setTimeout(100);
      await poll(attemptsLeft - 1);
    }
  };
  await poll(150);
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
    await poll(attemptsLeft - 1);
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
  await page.evaluate((value) => {
    localStorage.setItem("orbis.apiKey", value);
  }, key);
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
