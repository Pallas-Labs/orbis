import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { QueueEventSchema } from "@orbis/contracts/http-api";
import { Schema } from "effect";

import { startFixtureServer } from "./fixture-server.js";
import { hashToken } from "./identity.js";
import { createTestApp as createApp } from "./test-app.js";
import { eventStream } from "./test-http.js";

const decodeIdOnly = Schema.decodeUnknownSync(
  Schema.Struct({ id: Schema.String })
);

const decode = Schema.decodeUnknownSync(
  Schema.fromJsonString(QueueEventSchema)
);
type PresenceEntry = Extract<
  ReturnType<typeof decode>,
  { kind: "presence" }
>["presence"][number];

const stream = (response: Response) => {
  const frames = eventStream(response);
  const read = async () => {
    const raw = await frames.next();
    if (raw === null) {
      throw new Error("The event stream closed");
    }
    return decode(raw);
  };
  return {
    close: () => frames.close(),
    /** Reads frames until a presence event satisfies `accept`; fails after `ms`. */
    presence: (
      accept: (usernames: string[]) => boolean,
      ms = 6000
    ): Promise<readonly PresenceEntry[]> => {
      const timer = Bun.sleep(ms).then(() => null);
      const attempt = async (): Promise<readonly PresenceEntry[]> => {
        const event = await Promise.race([read(), timer]);
        if (event === null) {
          throw new Error("No matching presence event arrived");
        }
        if (event.kind === "presence") {
          const names = event.presence.map((entry) => entry.username);
          if (accept(names)) {
            return event.presence;
          }
        }
        return await attempt();
      };
      return attempt();
    },
  };
};

test("Presence reaches only viewers who pass the gate and lapses when reports stop", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbis-presence-"));
  const databasePath = path.join(root, "library.sqlite");
  await writeFile(
    path.join(root, "devices.json"),
    JSON.stringify({
      keys: ["a", "b", "c"].map((id) => ({
        addedAt: "2026-01-01T00:00:00.000Z",
        id,
        label: id,
        lastUsedAt: null,
        personId: id,
        scope: "daily",
        tokenHash: hashToken(id),
      })),
      people: ["host", "a", "b", "c"].map((id) => ({
        autoDownload: false,
        id,
        removed: false,
        social: id !== "host",
        username: id,
      })),
      version: 2,
    })
  );
  const listeners = startFixtureServer({
    app: createApp({
      databasePath,
      logging: { silent: true },
      presenceWindowMs: 3000,
    }),
    port: 0,
    token: "seeded-test-fixture",
  });
  const address = listeners.url;
  const call = (
    key: string,
    route: string,
    method = "GET",
    payload?:
      | { setId: string }
      | { seconds: number }
      | { see: boolean }
      | { title: string; url: string }
  ) => {
    const init: RequestInit = {
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      method,
    };
    if (payload !== undefined) {
      init.body = JSON.stringify(payload);
    }
    return fetch(new URL(route, address), init);
  };
  const statusOf = async (...args: Parameters<typeof call>) => {
    const response = await call(...args);
    return response.status;
  };
  const opened: ReturnType<typeof stream>[] = [];
  try {
    const viewerA = stream(await call("a", "/events"));
    const viewerC = stream(await call("c", "/events"));
    opened.push(viewerA, viewerC);
    // C hides from nobody but A stops seeing C; B is later hidden from C.
    expect(
      await statusOf("c", "/people/b/filters", "PUT", { see: false })
    ).toBe(200);
    await viewerA.presence((names) => names.length === 0);

    const saved = await call("b", "/sets", "POST", {
      title: "Presence Set",
      url: "https://www.youtube.com/watch?v=abcdefghijk",
    });
    const set = decodeIdOnly(await saved.json());
    const sqlite = new Database(databasePath);
    sqlite.run("UPDATE sets SET download_state = 'ready' WHERE id = ?", [
      set.id,
    ]);
    sqlite.close();
    expect(await statusOf("b", "/queue/active", "PUT", { setId: set.id })).toBe(
      200
    );
    expect(
      await statusOf("b", `/sets/${set.id}/position`, "PUT", { seconds: 5 })
    ).toBe(200);

    const seen = await viewerA.presence((names) => names.includes("b"));
    expect(seen).toMatchObject([{ personId: "b", set: { id: set.id } }]);
    // C fails the gate, so C never receives B's Presence.
    await assert.rejects(
      viewerC.presence((names) => names.includes("b"), 2500),
      /No matching presence event arrived/u
    );
    // B stops reporting, so the Presence lapses.
    await viewerA.presence((names) => names.length === 0);
  } finally {
    await Promise.all(opened.map((open) => open.close().catch(() => null)));
    await listeners.stop();
    await rm(root, { force: true, recursive: true });
  }
});
