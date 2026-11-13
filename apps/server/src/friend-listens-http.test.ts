import { Database as SqliteDatabase } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApp } from "./app.js";
import { hashToken } from "./identity.js";
import {
  idIn,
  request,
  runInOrder,
  statusLine,
  transcript,
} from "./test-http.js";

interface ListenBody {
  readonly finishedAt: string | null;
  readonly set: { readonly id: string };
  readonly startedAt: string;
}
interface PageBody {
  readonly listens: readonly ListenBody[];
  readonly nextCursor: string | null;
}

const SEEDED = 250;
const minute = (index: number) =>
  new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();

// Ways paging could go wrong, each shown below: a page holds more than the
// limit; the second page repeats or skips a Listen at the edge, most likely
// when two Listens share a `startedAt`; the last page still names a cursor; a
// forged cursor reads from the start or fails with 500; a limit outside 1-200
// is taken; a Person the caller cannot see answers a page, with or without a
// cursor.
test("A friend's Listen History reads in pages of 200, newest first, to the end", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-listens-"));
  const tokens = { a: "alice-key", b: "bob-key" };
  const devicesPath = path.join(directory, "devices.json");
  await writeFile(
    devicesPath,
    JSON.stringify({
      keys: Object.entries(tokens).map(([personId, token]) => ({
        addedAt: "2026-09-29T00:00:00.000Z",
        id: `${personId}-key`,
        label: "phone",
        lastUsedAt: null,
        personId,
        scope: "daily",
        tokenHash: hashToken(token),
      })),
      people: [
        { id: "host", removed: false, username: "host" },
        { id: "a", removed: false, username: "alice" },
        { id: "b", removed: false, username: "bob" },
      ],
      version: 2,
    })
  );
  const app = createApp({
    databasePath: path.join(directory, "library.sqlite"),
    devicesPath,
  });
  const call = (
    who: "a" | "b",
    method: string,
    url: string,
    payload?: { [key: string]: string | boolean }
  ) =>
    request(app, {
      accessMode: "device",
      headers: { authorization: `Bearer ${tokens[who]}` },
      host: "orbis.example.test",
      method,
      payload,
      url,
    });
  const log = transcript();
  try {
    const early = idIn(
      await call("b", "POST", "/sets", {
        url: "https://www.youtube.com/watch?v=abcdefghijk",
      })
    );
    const late = idIn(
      await call("b", "POST", "/sets", {
        url: "https://www.youtube.com/watch?v=lmnopqrstuv",
      })
    );
    // `<Set 1>` is `early`, `<Set 2>` is `late`.
    const setName = (id: string) => log.name("Set", id);
    setName(early);
    setName(late);
    // Listen n (1 to 250) starts at minute n and plays `late`, except Listens
    // 50 and 51: both start at minute 51 and play `early` then `late`. Newest
    // first, Listen 51 is the 200th and Listen 50 the 201st, so the tie sits
    // on the page edge and only `id` orders it.
    const sqlite = new SqliteDatabase(path.join(directory, "library.sqlite"));
    const insertListen = sqlite.query(
      "INSERT INTO listens (person_id, set_id, started_at, finished_at) VALUES ('b', ?, ?, ?)"
    );
    const newestFirst: { set: string; startedAt: string }[] = [];
    sqlite.transaction(() => {
      for (let index = 1; index <= SEEDED; index += 1) {
        const set = index === 50 ? early : late;
        const startedAt = minute(index === 50 ? 51 : index);
        insertListen.run(set, startedAt, startedAt);
        newestFirst.unshift({ set, startedAt });
      }
    })();
    sqlite.close();

    const listensOfB = "/people/b/listens";
    const hiddenFirst = await call("a", "GET", listensOfB);
    log.step(
      "GET /people/b/listens, before either turns Social on",
      statusLine(hiddenFirst)
    );
    await call("a", "PATCH", "/me", { social: true });
    await call("b", "PATCH", "/me", { social: true });

    const describePage = (response: Awaited<ReturnType<typeof call>>) => {
      if (response.statusCode !== 200) {
        return statusLine(response);
      }
      const page: PageBody = response.json();
      const first = page.listens.at(0);
      const last = page.listens.at(-1);
      const range =
        first === undefined || last === undefined
          ? "none"
          : `${first.startedAt} (${setName(first.set.id)}) .. ${last.startedAt} (${setName(last.set.id)})`;
      const cursor =
        page.nextCursor === null ? "null" : log.name("cursor", page.nextCursor);
      return `200, ${page.listens.length} Listens, ${range}, nextCursor ${cursor}`;
    };

    const firstPage = await call("a", "GET", listensOfB);
    log.step("GET /people/b/listens", describePage(firstPage));
    const firstBody: PageBody = firstPage.json();
    const cursor = firstBody.nextCursor ?? "";
    const secondPage = await call(
      "a",
      "GET",
      `${listensOfB}?before=${encodeURIComponent(cursor)}`
    );
    log.step(
      `GET /people/b/listens?before=${log.name("cursor", cursor)}`,
      describePage(secondPage)
    );
    const secondBody: PageBody = secondPage.json();
    const joined = [...firstBody.listens, ...secondBody.listens].map(
      (listen) => ({ set: listen.set.id, startedAt: listen.startedAt })
    );
    log.step(
      "both pages joined, against the 250 seeded Listens newest first",
      Bun.deepEquals(joined, newestFirst)
        ? "equal: none repeated or missing"
        : "different"
    );

    const small = await call("a", "GET", `${listensOfB}?limit=3`);
    log.step("GET /people/b/listens?limit=3", describePage(small));
    const smallCursor = small.json().nextCursor ?? "";
    log.step(
      `GET /people/b/listens?limit=3&before=${log.name("cursor", smallCursor)}`,
      describePage(
        await call(
          "a",
          "GET",
          `${listensOfB}?limit=3&before=${encodeURIComponent(smallCursor)}`
        )
      )
    );

    const forged = Buffer.from('["2026-01-01T00:00:00.000Z","x"]').toString(
      "base64url"
    );
    await runInOrder(
      [
        ["before=not-a-cursor", "before=not-a-cursor"],
        ["before=<a cursor whose id is not a number>", `before=${forged}`],
        ["limit=0", "limit=0"],
        ["limit=201", "limit=201"],
        ["limit=2.5", "limit=2.5"],
      ] as const,
      async ([label, query]) => {
        const refused = await call("a", "GET", `${listensOfB}?${query}`);
        log.step(`GET /people/b/listens?${label}`, statusLine(refused));
      }
    );

    await call("a", "PUT", "/people/b/filters", { see: false });
    log.step(
      "GET /people/b/listens, after Alice turns See off for Bob",
      statusLine(await call("a", "GET", listensOfB))
    );
    log.step(
      `GET /people/b/listens?before=${log.name("cursor", cursor)}, See still off`,
      statusLine(
        await call(
          "a",
          "GET",
          `${listensOfB}?before=${encodeURIComponent(cursor)}`
        )
      )
    );

    expect(log.text()).toMatchInlineSnapshot(`
      "
      GET /people/b/listens, before either turns Social on  -> 404 "Person not found."
      GET /people/b/listens  -> 200, 200 Listens, 2026-01-01T04:10:00.000Z (<Set 2>) .. 2026-01-01T00:51:00.000Z (<Set 2>), nextCursor <cursor 1>
      GET /people/b/listens?before=<cursor 1>  -> 200, 50 Listens, 2026-01-01T00:51:00.000Z (<Set 1>) .. 2026-01-01T00:01:00.000Z (<Set 2>), nextCursor null
      both pages joined, against the 250 seeded Listens newest first  -> equal: none repeated or missing
      GET /people/b/listens?limit=3  -> 200, 3 Listens, 2026-01-01T04:10:00.000Z (<Set 2>) .. 2026-01-01T04:08:00.000Z (<Set 2>), nextCursor <cursor 2>
      GET /people/b/listens?limit=3&before=<cursor 2>  -> 200, 3 Listens, 2026-01-01T04:07:00.000Z (<Set 2>) .. 2026-01-01T04:05:00.000Z (<Set 2>), nextCursor <cursor 3>
      GET /people/b/listens?before=not-a-cursor  -> 400 "This page of Listens does not exist."
      GET /people/b/listens?before=<a cursor whose id is not a number>  -> 400 "This page of Listens does not exist."
      GET /people/b/listens?limit=0  -> 400
      GET /people/b/listens?limit=201  -> 400
      GET /people/b/listens?limit=2.5  -> 400
      GET /people/b/listens, after Alice turns See off for Bob  -> 404 "Person not found."
      GET /people/b/listens?before=<cursor 1>, See still off  -> 404 "Person not found."
      "
    `);
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});
