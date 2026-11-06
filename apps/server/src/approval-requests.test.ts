// Signing in a device by Approval Request through `createApp` over HTTP with a
// real database.
//
// Ways it could fail, each covered below:
// - A code is not 6 digits, two live requests share a code, the expiry is not
//   2 minutes out, or a proxy may cache the code or the secret.
// - A blank or overlong device name is accepted.
// - A wait answers before its wait time with no approval, or an open wait
//   does not wake when the request is approved.
// - The key belongs to the wrong Person, is not daily, lacks the device's
//   name, or does not work.
// - The key is handed out twice, or a used code can still be found or
//   approved.
// - A signed-out caller is told 403 instead of being asked to sign in, or a
//   node key approves a device.
// - Guessing codes or secrets is not limited, or a client over the limit
//   still learns that a guess was right.
// - A wait with the real secret counts as a failure, so the waiting device
//   locks itself out.
// - An expired request can still be found, approved, or collected.
// - One client, one /64, or the whole Group can hold any number of live
//   requests.
// - A log event carries the code, the secret, or the key.
//
// The transcript test below prints the whole flow as text, so a change to any
// of these rules shows in its snapshot diff:
// - The code typed with a space is not found, the approver is not the Person
//   the key belongs to, or the key does not sign in on GET /me.
// - A wrong code is found, or a used request hands out a second key.
// - The 2-minute expiry is off by one in either direction.
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ApprovalRequestSchema,
  ApprovalWaitSchema,
  StartedApprovalRequestSchema,
} from "@orbis/contracts/http-api";
import { Schema } from "effect";
import type { WideEvent } from "evlog";

import { createApp } from "./app.js";
import { hashToken, readTrustStrict } from "./identity.js";
import { storedKey } from "./test-app.js";
import {
  relativeTime,
  request,
  runInOrder,
  runTimesInOrder,
  statusLine,
  transcript,
} from "./test-http.js";

const FRIEND_DAILY = "approval-friend-daily";
const NODE = "approval-node";
const TV = "100.64.1.1";
const PHONE = "100.64.2.1";
const TWO_MINUTES = 2 * 60 * 1000;
const WAIT_MS = 1000;

const decodeStarted = Schema.decodeUnknownSync(StartedApprovalRequestSchema);
const decodeWait = Schema.decodeUnknownSync(ApprovalWaitSchema);
const decodeRequest = Schema.decodeUnknownSync(ApprovalRequestSchema);
const decodeMe = Schema.decodeUnknownSync(
  Schema.Struct({ username: Schema.String })
);

const setup = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-approval-"));
  const devicesPath = path.join(directory, "devices.json");
  await writeFile(
    devicesPath,
    JSON.stringify({
      keys: [
        storedKey("friend-daily", "friend", FRIEND_DAILY, "daily"),
        storedKey("host-node", "host", NODE, "node"),
      ],
      people: [
        { id: "host", removed: false, username: "host" },
        { id: "friend", removed: false, username: "Friend" },
      ],
      version: 2,
    })
  );
  const clock = { now: Date.UTC(2026, 0, 1) };
  const events: WideEvent[] = [];
  const app = createApp({
    approvalWaitMs: WAIT_MS,
    databasePath: path.join(directory, "library.sqlite"),
    devicesPath,
    logging: {
      onEvent: (event) => {
        events.push(event);
      },
      silent: true,
    },
    signInCodeNow: () => clock.now,
  });
  const store = () => readTrustStrict(devicesPath);
  const cleanup = async () => {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  };
  return { app, cleanup, clock, events, store };
};

type App = ReturnType<typeof createApp>;

interface Answer {
  readonly body: unknown;
  readonly cacheControl: string | null;
  readonly status: number;
}

const send = async (
  app: App,
  url: string,
  options: { client: string; key?: string; payload?: unknown }
): Promise<Answer> => {
  const response = await request(app, {
    accessMode: "device",
    clientAddress: options.client,
    headers:
      options.key === undefined
        ? {}
        : { authorization: `Bearer ${options.key}` },
    host: "vanta.example.ts.net",
    method: "POST",
    payload: options.payload,
    url,
  });
  return {
    body: response.json(),
    cacheControl: response.headers.get("cache-control"),
    status: response.statusCode,
  };
};
const statusOf = async (answer: Promise<Answer>) => {
  const settled = await answer;
  return settled.status;
};

const start = (app: App, client = TV, label = "Living room TV") =>
  send(app, "/sign-in/requests", {
    client,
    payload: { label, platform: "tvOS" },
  });
const started = async (app: App, client = TV) => {
  const response = await start(app, client);
  expect(response.status).toBe(201);
  return decodeStarted(response.body);
};
const wait = (app: App, secret: string, client = TV) =>
  send(app, "/sign-in/requests/wait", { client, payload: { secret } });
const find = (app: App, code: string, client = PHONE, key = FRIEND_DAILY) =>
  send(app, "/me/sign-in-requests/find", { client, key, payload: { code } });
const approve = (app: App, code: string, client = PHONE, key = FRIEND_DAILY) =>
  send(app, "/me/sign-in-requests/approve", {
    client,
    key,
    payload: { code },
  });
const said = (answer: Answer) =>
  statusLine({ json: () => answer.body, statusCode: answer.status });
const approvedKey = (answer: Answer) => {
  expect(answer.status).toBe(200);
  expect(answer.cacheControl).toBe("no-store");
  const result = decodeWait(answer.body);
  if (result.status !== "approved") {
    throw new Error(`expected approved, got ${result.status}`);
  }
  return result;
};

test("starting returns a 6-digit code, a secret, and a 2-minute expiry, none of them cached", async () => {
  const { app, cleanup, clock } = await setup();
  try {
    const response = await start(app);
    expect(response.status).toBe(201);
    expect(response.cacheControl).toBe("no-store");
    const first = decodeStarted(response.body);
    expect(first.code).toMatch(/^\d{6}$/u);
    expect(first.secret).toMatch(/^[\w-]{43}$/u);
    expect(Date.parse(first.expiresAt) - clock.now).toBe(TWO_MINUTES);

    const live = await Promise.all(
      Array.from({ length: 19 }, (_, index) =>
        started(app, `100.64.3.${Math.floor(index / 3)}`)
      )
    );
    const all = [first, ...live];
    expect(new Set(all.map((pairing) => pairing.code)).size).toBe(20);
    expect(new Set(all.map((pairing) => pairing.secret)).size).toBe(20);
  } finally {
    await cleanup();
  }
});

test.each(["", "   ", "x".repeat(101)])(
  "a device name %p is refused",
  async (label) => {
    const { app, cleanup } = await setup();
    try {
      expect(await statusOf(start(app, TV, label))).toBe(400);
    } finally {
      await cleanup();
    }
  }
);

test("transcript: a TV is approved, signs in once, and its request expires after 2 minutes", async () => {
  const { app, cleanup, clock } = await setup();
  const origin = clock.now;
  const t = transcript();
  try {
    const startAnswer = await start(app);
    const pairing = decodeStarted(startAnswer.body);
    const code = t.name("code", pairing.code);
    const secret = t.name("secret", pairing.secret);
    t.step(
      'start "Living room TV" on tvOS',
      `${said(startAnswer)}, code ${code}, secret ${secret}, expires ${relativeTime(Date.parse(pairing.expiresAt), origin)}`
    );

    const typed = `${pairing.code.slice(0, 3)} ${pairing.code.slice(3)}`;
    const found = await find(app, typed);
    const shown = decodeRequest(found.body);
    t.step(
      `find ${code} typed as "ddd ddd"`,
      `${said(found)}, "${shown.label}" on ${shown.platform}, requested ${relativeTime(Date.parse(shown.requestedAt), origin)}`
    );
    t.step(`approve ${code} as Friend`, said(await approve(app, pairing.code)));

    const collected = await wait(app, pairing.secret);
    const result = decodeWait(collected.body);
    t.step(
      `wait ${secret}`,
      result.status === "approved"
        ? `${said(collected)}, approved as ${result.person.username}, key ${t.name("key", result.key)}`
        : `${said(collected)}, ${result.status}`
    );
    if (result.status === "approved") {
      const me = await app.handler(
        new Request("http://vanta.example.ts.net/me", {
          headers: { authorization: `Bearer ${result.key}` },
        }),
        "device",
        TV
      );
      const person = decodeMe(await me.json());
      t.step(
        `GET /me with ${t.name("key", result.key)}`,
        `${me.status} ${person.username}`
      );
    }

    const wrong = String((Number(pairing.code) + 1) % 1_000_000).padStart(
      6,
      "0"
    );
    t.step(`find ${t.name("wrong code", wrong)}`, said(await find(app, wrong)));
    t.step(`wait ${secret} again`, said(await wait(app, pairing.secret)));
    t.step(`find ${code} again`, said(await find(app, pairing.code)));

    const later = await started(app);
    const laterCode = t.name("code", later.code);
    t.step(
      'start "Living room TV" on tvOS',
      `201, code ${laterCode}, expires ${relativeTime(Date.parse(later.expiresAt), origin)}`
    );
    clock.now += TWO_MINUTES - 1;
    t.step(
      `at ${relativeTime(clock.now, origin)} find ${laterCode}`,
      said(await find(app, later.code))
    );
    clock.now += 1;
    t.step(
      `at ${relativeTime(clock.now, origin)} find ${laterCode}`,
      said(await find(app, later.code))
    );
    t.step(
      `at ${relativeTime(clock.now, origin)} approve ${laterCode}`,
      said(await approve(app, later.code))
    );

    expect(t.text()).toMatchInlineSnapshot(`
      "
      start "Living room TV" on tvOS  -> 201, code <code 1>, secret <secret 1>, expires +2m
      find <code 1> typed as "ddd ddd"  -> 200, "Living room TV" on tvOS, requested +0s
      approve <code 1> as Friend  -> 200
      wait <secret 1>  -> 200, approved as Friend, key <key 1>
      GET /me with <key 1>  -> 200 Friend
      find <wrong code 1>  -> 404 "No device is waiting with that code."
      wait <secret 1> again  -> 404 "That sign-in request expired. Start again."
      find <code 1> again  -> 404 "No device is waiting with that code."
      start "Living room TV" on tvOS  -> 201, code <code 2>, expires +2m
      at +1m59.999s find <code 2>  -> 200
      at +2m find <code 2>  -> 404 "No device is waiting with that code."
      at +2m approve <code 2>  -> 404 "No device is waiting with that code."
      "
    `);
  } finally {
    await cleanup();
  }
});

test("a wait holds until its wait time and answers pending, and an open wait answers approved at once with a key for the approver", async () => {
  const { app, cleanup, clock, store } = await setup();
  try {
    const unapproved = await started(app);
    const pairing = await started(app);
    const answered: string[] = [];
    const track = async (name: string, answer: Promise<Answer>) => {
      const settled = await answer;
      answered.push(name);
      return settled;
    };
    // An in-process request settles without yielding to timers, so each wait
    // gets a timer tick, shorter than WAIT_MS, to start holding.
    const pendingWait = track("pending", wait(app, unapproved.secret));
    await Bun.sleep(WAIT_MS / 4);
    const openWait = track("approved", wait(app, pairing.secret));
    await Bun.sleep(WAIT_MS / 4);
    expect(answered).toEqual([]);
    const typed = `${pairing.code.slice(0, 3)} ${pairing.code.slice(3)}`;
    const found = await find(app, typed);
    expect(found.status).toBe(200);
    expect(decodeRequest(found.body)).toEqual({
      code: pairing.code,
      label: "Living room TV",
      platform: "tvOS",
      requestedAt: new Date(clock.now).toISOString(),
    });

    expect(await statusOf(approve(app, pairing.code))).toBe(200);
    const [pending, collected] = await Promise.all([pendingWait, openWait]);
    // The approved wait answered before a wait opened earlier ran out its
    // WAIT_MS, so it woke on approval, within WAIT_MS of it.
    expect(answered).toEqual(["approved", "pending"]);
    expect(pending.status).toBe(200);
    expect(pending.cacheControl).toBe("no-store");
    expect(decodeWait(pending.body)).toEqual({ status: "pending" });
    const result = approvedKey(collected);
    expect(result.person).toEqual({ id: "friend", username: "Friend" });
    expect(
      store().keys.find((key) => key.tokenHash === hashToken(result.key))
    ).toMatchObject({
      label: "Living room TV",
      personId: "friend",
      scope: "daily",
    });
    const me = await app.handler(
      new Request("http://vanta.example.ts.net/me", {
        headers: { authorization: `Bearer ${result.key}` },
      }),
      "device",
      TV
    );
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ id: "friend", username: "Friend" });
  } finally {
    await cleanup();
  }
});

test("an approved request hands out its key once, and its code cannot be used again", async () => {
  const { app, cleanup, store } = await setup();
  try {
    const pairing = await started(app);
    expect(await statusOf(approve(app, pairing.code))).toBe(200);
    const concurrent = await Promise.all([
      statusOf(wait(app, pairing.secret)),
      statusOf(wait(app, pairing.secret)),
    ]);
    expect(new Set(concurrent)).toEqual(new Set([200, 404]));
    expect(await statusOf(wait(app, pairing.secret))).toBe(404);
    expect(await statusOf(find(app, pairing.code))).toBe(404);
    expect(await statusOf(approve(app, pairing.code))).toBe(404);
    expect(store().keys).toHaveLength(3);
  } finally {
    await cleanup();
  }
});

test.each([
  ["find", "/me/sign-in-requests/find"],
  ["approve", "/me/sign-in-requests/approve"],
])(
  "%s asks a signed-out caller to sign in and refuses a node key",
  async (_name, url) => {
    const { app, cleanup } = await setup();
    try {
      const pairing = await started(app);
      const signedOut = await send(app, url, {
        client: PHONE,
        payload: { code: pairing.code },
      });
      expect(signedOut.status).toBe(401);
      expect(signedOut.body).toEqual({
        message: "Sign in to approve a device.",
      });
      const node = send(app, url, {
        client: PHONE,
        key: NODE,
        payload: { code: pairing.code },
      });
      expect(await statusOf(node)).toBe(403);
      expect(await statusOf(find(app, pairing.code))).toBe(200);
      const other = await app.handler(
        new Request("http://vanta.example.ts.net/me"),
        "device",
        PHONE
      );
      expect(other.status).toBe(403);
    } finally {
      await cleanup();
    }
  }
);

test("wrong codes and secrets count as failed sign-in attempts, and the waiting device never does", async () => {
  const { app, cleanup } = await setup();
  try {
    const pairing = await started(app);
    const wrong = (attempt: number) =>
      String((Number(pairing.code) + attempt + 1) % 1_000_000).padStart(6, "0");
    const statuses: number[] = [];
    await runTimesInOrder(21, async (attempt) => {
      const guess = attempt % 2 === 0 ? find : approve;
      statuses.push(await statusOf(guess(app, wrong(attempt))));
    });
    expect(statuses.slice(0, 20)).toEqual(
      Array.from({ length: 20 }, () => 404)
    );
    expect(statuses[20]).toBe(429);
    // Over the limit, a right code is refused before the lookup.
    expect(await statusOf(find(app, pairing.code))).toBe(429);
    expect(await statusOf(approve(app, pairing.code))).toBe(429);
    expect(await statusOf(find(app, pairing.code, "100.64.2.2"))).toBe(200);

    const secrets: number[] = [];
    await runTimesInOrder(21, async (attempt) => {
      secrets.push(await statusOf(wait(app, `guess-${attempt}`, "100.64.4.1")));
    });
    expect(secrets.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 404));
    expect(secrets[20]).toBe(429);
    // The device waiting on its own request is not locked out.
    const own = await wait(app, pairing.secret, "100.64.4.1");
    expect(decodeWait(own.body)).toEqual({ status: "pending" });
  } finally {
    await cleanup();
  }
});

test("after 2 minutes a request cannot be found, approved, or collected", async () => {
  const { app, cleanup, clock } = await setup();
  try {
    const pairing = await started(app);
    clock.now += TWO_MINUTES - 1;
    expect(await statusOf(find(app, pairing.code))).toBe(200);
    clock.now += 1;
    expect(await statusOf(find(app, pairing.code))).toBe(404);
    expect(await statusOf(approve(app, pairing.code))).toBe(404);
    expect(await statusOf(wait(app, pairing.secret))).toBe(404);
  } finally {
    await cleanup();
  }
});

test("one client holds 3 live requests and the Group holds 20", async () => {
  const { app, cleanup, clock } = await setup();
  try {
    await runInOrder(
      ["2001:db8:1:2::1", "2001:db8:1:2::2", "2001:db8:1:2::3"],
      async (address) => {
        expect(await statusOf(start(app, address))).toBe(201);
      }
    );
    const fourth = await start(app, "2001:db8:1:2::4");
    expect(fourth.status).toBe(429);
    expect(fourth.body).toEqual({
      message:
        "Too many devices are waiting to sign in. Try again in two minutes.",
    });

    await runTimesInOrder(17, async (index) => {
      expect(await statusOf(start(app, `100.64.5.${index}`))).toBe(201);
    });
    expect(await statusOf(start(app, "100.64.6.1"))).toBe(429);

    clock.now += TWO_MINUTES;
    expect(await statusOf(start(app, "2001:db8:1:2::4"))).toBe(201);
  } finally {
    await cleanup();
  }
});

test("no log event carries the code, the secret, or the key", async () => {
  const { app, cleanup, events } = await setup();
  try {
    const pairing = await started(app);
    const pending = await wait(app, pairing.secret);
    expect(decodeWait(pending.body)).toEqual({ status: "pending" });
    expect(await statusOf(find(app, pairing.code))).toBe(200);
    expect(await statusOf(approve(app, pairing.code))).toBe(200);
    const collected = approvedKey(await wait(app, pairing.secret));
    expect(await statusOf(wait(app, pairing.secret))).toBe(404);
    expect(events.length).toBeGreaterThanOrEqual(6);
    const logged = JSON.stringify(events);
    expect(logged).not.toMatch(
      new RegExp(`(?<!\\d)${pairing.code}(?!\\d)`, "u")
    );
    expect(logged).not.toContain(pairing.secret);
    expect(logged).not.toContain(collected.key);
  } finally {
    await cleanup();
  }
});
