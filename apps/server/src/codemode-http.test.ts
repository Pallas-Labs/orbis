// Orbis Code Mode (`@orbis/mcp`, PAL-3053) against `createApp` over HTTP with a real database. The
// engine's client sends each call through the app's handler with a real device key, as the stdio
// server sends it to the service.
//
// Ways it could fail:
// - `search` misses a capability, or gives a declaration that does not match its input.
// - A program cannot join namespaces in one run, or a capability reads another Person's library.
// - A curation write does not reach the service, so a plain read after it shows the old tags.
// - A typo in a function name fails with no hint, so an agent cannot correct it.
// - A program that never ends holds the server past its time limit.
// - A program writes to a Playlist another Person created and shared with the caller.
// - The catalog, or `search`, offers a delete, an admin or sign-in call, a key, presence,
//   or a change to who may edit a Playlist.
// - The MCP server lists tools other than `search` and `execute`.
//
// The transcript prints each answer, so a change to these rules shows in its snapshot diff.
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { LibraryResponseSchema } from "@orbis/contracts/http-api";
import {
  catalog,
  execute,
  OrbisClient,
  registrations,
  search,
} from "@orbis/mcp";
import type { CodemodeResult } from "@orbis/mcp";
import { Effect, Layer, Redacted, Schema } from "effect";
import { McpProtocol, McpTest } from "effect/ai";
import { FetchHttpClient } from "effect/http";

import { createApp } from "./app.js";
import { hashToken } from "./identity.js";
import { request, transcript } from "./test-http.js";
import { ready, seedSets } from "./test-library.js";

const tokens = { friend: "friend-key", host: "host-key" } as const;
const decodeSets = Schema.decodeUnknownSync(LibraryResponseSchema);

/** What no capability may do, by its path or its description. */
const forbidden =
  /delete|remove|admin|sign-?in|device|presence|collaborat|editor/iu;

/** A client with the host's key whose every call goes to `handle`, as `fetch` would send it. */
const clientThrough = (handle: (sent: Request) => Promise<Response>) =>
  OrbisClient.make({
    baseUrl: "http://127.0.0.1:4310/",
    token: Redacted.make(tokens.host),
  }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(
      Layer.succeed(
        FetchHttpClient.Fetch,
        Object.assign(
          async (input: RequestInfo | URL, init?: RequestInit) =>
            await handle(new Request(input, init)),
          { preconnect: globalThis.fetch.preconnect }
        )
      )
    )
  );

/** One result as a line: the value, or the error's kind, message and suggestions. */
const said = (result: CodemodeResult) => {
  const calls = result.toolCalls.map((each) => each.path).join(" ");
  if (result.ok) {
    return `${JSON.stringify(result.value)}${calls === "" ? "" : ` (calls: ${calls})`}`;
  }
  const { kind, message, suggestions = [] } = result.error;
  return `${kind}: ${message}${suggestions.length === 0 ? "" : ` (did you mean ${suggestions.join(", ")})`}`;
};

test("transcript: a Code Mode program reads and curates the caller's library in one call", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-codemode-"));
  const databasePath = path.join(directory, "library.sqlite");
  const devicesPath = path.join(directory, "devices.json");
  try {
    await writeFile(
      devicesPath,
      JSON.stringify({
        keys: Object.entries(tokens).map(([personId, token]) => ({
          addedAt: "2026-11-01T00:00:00.000Z",
          id: `${personId}-key`,
          label: "test",
          lastUsedAt: null,
          personId,
          scope: "daily",
          tokenHash: hashToken(token),
        })),
        people: [
          { id: "host", removed: false, username: "host" },
          { id: "friend", removed: false, username: "friend" },
        ],
        version: 2,
      })
    );
    await seedSets(databasePath, ready(["a", "b", "c", "d"]));
    const app = createApp({ databasePath, devicesPath });
    try {
      const t = transcript();
      const as = (who: keyof typeof tokens) => ({
        authorization: `Bearer ${tokens[who]}`,
      });
      const call = async (
        who: keyof typeof tokens,
        method: string,
        url: string,
        payload?: Record<string, string | string[] | boolean>
      ) => {
        const response = await request(app, {
          headers: as(who),
          method,
          payload,
          url,
        });
        expect(response.statusCode).toBeLessThan(300);
        return response.json();
      };

      // The engine's only door: the app's own handler, reached with the host's key.
      const client = clientThrough(
        async (sent) => await app.handler(sent, "device")
      );
      const run = (code: string, timeoutMs?: number) =>
        Effect.runPromise(
          execute(code, { timeoutMs }).pipe(Effect.provide(client))
        );

      // The library: a and b tagged techno, a and c in the host's playlist "Warm up".
      await call("host", "PATCH", "/sets/a/tags", { tags: ["techno"] });
      await call("host", "PATCH", "/sets/b/tags", { tags: ["techno", "live"] });
      const warmUp = await call("host", "POST", "/playlists", {
        name: "Warm up",
      });
      await call("host", "PUT", `/playlists/${warmUp.id}/sets`, {
        setIds: ["a", "c"],
      });
      t.step(
        "seed",
        `host Sets a b c d; a [techno], b [techno, live]; ${t.name("playlist", warmUp.id)} "Warm up" holds a c`
      );

      const found = search({ query: "tags" });
      t.step(
        "search tags",
        `${found.total}: ${found.results.map((each) => each.path).join(" ")}`
      );
      const [setTags] = search({
        namespace: "curate",
        query: "setTags",
      }).results;
      t.step(
        "  curate.setTags declaration",
        (setTags?.declaration ?? "none").replaceAll("\n", " ")
      );

      const joined = await run(`
        const [{ sets: techno }, { tags }, { playlists: own }] = await Promise.all([
          sets.list({ tag: ["techno"] }),
          library.tags(),
          playlists.list(),
        ]);
        const inPlaylists = new Set();
        for (const { id } of own) {
          for (const set of (await playlists.read({ id })).sets) {
            inPlaylists.add(set.id);
          }
        }
        return {
          tags,
          playlists: own.length,
          technoInAPlaylist: techno.filter((set) => inPlaylists.has(set.id)).length,
        };
      `);
      t.step("execute join Sets, tags and playlists", said(joined));

      const tagged = await run(`
        const changed = [];
        for (const id of ["c", "d"]) {
          const { tags } = await sets.read({ id });
          changed.push((await curate.setTags({ id, tags: [...tags, "sunrise"] })).id);
        }
        return changed;
      `);
      t.step('execute tag c and d "sunrise"', said(tagged));
      const sunrise = decodeSets(
        await call("host", "GET", "/sets?tag=sunrise")
      ).sets;
      t.step(
        "  GET /sets?tag=sunrise",
        sunrise.map((set) => `${set.id} [${set.tags.join(", ")}]`).join(" ")
      );

      t.step(
        "execute sets.lsit()",
        said(await run("return await sets.lsit();"))
      );
      t.step(
        "execute curate.setTag(…)",
        said(await run('return await curate.setTag({ id: "a", tags: [] });'))
      );

      const stopped = await run("while (true) {}", 100);
      t.step(
        "execute while (true) {} with timeoutMs 100",
        stopped.ok ? "kept running" : stopped.error.kind
      );

      // A Playlist the friend created and lets the host edit: the service accepts the host's write,
      // so the catalog refuses it before it is sent.
      await call("host", "PATCH", "/me", { social: true });
      await call("friend", "PATCH", "/me", { social: true });
      const shared = await call("friend", "POST", "/playlists", {
        name: "Friend's mix",
      });
      await call("friend", "PUT", `/playlists/${shared.id}/collaboration`, {
        collaborative: true,
      });
      await call("friend", "PUT", `/playlists/${shared.id}/editors`, {
        editorIds: ["host"],
      });
      t.step(
        "friend shares",
        `${t.name("playlist", shared.id)} "Friend's mix", host may edit`
      );
      const intoShared = await run(`
        const [{ id }] = (await playlists.shared()).playlists;
        return await curate.setPlaylistSets({ id, setIds: ["a"] });
      `);
      t.step(
        "execute curate.setPlaylistSets on it",
        said(intoShared).replace(shared.id, t.name("playlist", shared.id))
      );
      const friendMix = await call("friend", "GET", `/playlists/${shared.id}`);
      t.step(
        `  GET /playlists/${t.name("playlist", shared.id)}`,
        `${friendMix.sets.length} Sets`
      );

      const intoOwn = await run(`
        const { playlists: [warmUp] } = await playlists.list();
        const { sets } = await curate.setPlaylistSets({ id: warmUp.id, setIds: ["d", "a", "c"] });
        return sets.map((set) => set.id);
      `);
      t.step('execute curate.setPlaylistSets on "Warm up"', said(intoOwn));

      const sharedName = t.name("playlist", shared.id);
      const otherWrites = await run(`
        const [{ id }] = (await playlists.shared()).playlists;
        const tried = {};
        for (const [name, write] of [
          ["setPlaylists", () => curate.setPlaylists({ id: "a", playlistIds: [id] })],
          ["renamePlaylist", () => curate.renamePlaylist({ id, name: "Taken" })],
        ]) {
          try {
            await write();
            tried[name] = "written";
          } catch (error) {
            tried[name] = error.message;
          }
        }
        return tried;
      `);
      t.step(
        "execute curate.setPlaylists and renamePlaylist on it",
        said(otherWrites).replaceAll(shared.id, sharedName)
      );
      const afterOthers = await call(
        "friend",
        "GET",
        `/playlists/${shared.id}`
      );
      t.step(
        `  GET /playlists/${sharedName}`,
        `"${afterOthers.name}", ${afterOthers.sets.length} Sets`
      );

      // Every other capability once, against the real app: the names that threw.
      const rest = await run(`
        const { id: me } = await people.me();
        const created = await curate.createCollection({
          creatorId: null, minimumMinutes: 0, name: "All", range: "month", source: null, tag: "techno",
        });
        const steps = {
          "sets.tracklist": () => sets.tracklist({ id: "a" }),
          "sets.audioState": () => sets.audioState({ id: "a" }),
          "library.heavyRotation": () => library.heavyRotation({ range: "year" }),
          "library.collectionSets": () => library.collectionSets({ id: created.id }),
          "curate.updateCollection": () => curate.updateCollection({ ...created, name: "Techno", id: created.id }),
          "queue.read": () => queue.read(),
          "people.list": () => people.list(),
          "people.sets": () => people.sets({ id: "friend" }),
          "people.playlists": () => people.playlists({ id: "friend" }),
          "people.listens": () => people.listens({ id: "friend", limit: 5 }),
          "curate.createPlaylist": () => curate.createPlaylist({ name: "Later" }),
        };
        const failed = [];
        for (const [name, step] of Object.entries(steps)) {
          try { await step(); } catch (error) { failed.push(name + ": " + error.message); }
        }
        const { sets: audio } = await sets.list();
        return {
          me,
          failed,
          audio: (await Promise.all(audio.map((set) => sets.audioState({ id: set.id })))).map((each) => each.state),
          collections: (await library.collections()).collections.map((each) => each.name),
        };
      `);
      t.step(
        "execute every other capability",
        rest.ok ? JSON.stringify(rest.value) : said(rest)
      );

      expect(t.text()).toMatchInlineSnapshot(`
        "
        seed  -> host Sets a b c d; a [techno], b [techno, live]; <playlist 1> "Warm up" holds a c
        search tags  -> 3: library.tags curate.setTags sets.list
          curate.setTags declaration  -> /** Replaces one Set's tags with \`tags\` (at most 20, each at most 40 characters). Read the Set first to keep its other tags. */ function setTags(input: { id: string; tags: string[] }): Promise<{ artworkLargeUrl: string | null; artworkUrl: string | null; createdAt: string; creator: string | null; creatorId: string | null; downloadState: "none" | "queued" | "downloading" | "ready" | "failed" | "canceled"; durationSeconds: number | null; finishCount: number; id: string; lastListenedAt: string | null; listenCount: number; metadataState: "pending" | "enriched" | "failed"; playbackPositionSeconds: number; playlistIds: string[]; releasedAt: string | null; retainedAudioBytes: number | null; retainedAudioFormat: string | null; source: "youtube" | "soundcloud" | "apple-music"; tags: string[]; title: string; titleEditedByUser: boolean; tracklistState: "pending" | "ready" | "none" | "failed"; url: string }>;
        execute join Sets, tags and playlists  -> {"tags":["live","techno"],"playlists":1,"technoInAPlaylist":1} (calls: sets.list library.tags playlists.list playlists.read)
        execute tag c and d "sunrise"  -> ["c","d"] (calls: sets.read curate.setTags sets.read curate.setTags)
          GET /sets?tag=sunrise  -> d [sunrise] c [sunrise]
        execute sets.lsit()  -> ExecutionFailure: sets.lsit is not a function (did you mean sets.list)
        execute curate.setTag(…)  -> ExecutionFailure: curate.setTag is not a function (did you mean curate.setTags)
        execute while (true) {} with timeoutMs 100  -> TimeoutExceeded
        friend shares  -> <playlist 2> "Friend's mix", host may edit
        execute curate.setPlaylistSets on it  -> Refused: curate.setPlaylistSets: <playlist 2> is not your Playlist
          GET /playlists/<playlist 2>  -> 0 Sets
        execute curate.setPlaylistSets on "Warm up"  -> ["d","a","c"] (calls: playlists.list curate.setPlaylistSets)
        execute curate.setPlaylists and renamePlaylist on it  -> {"setPlaylists":"curate.setPlaylists: Playlist not found.","renamePlaylist":"curate.renamePlaylist: Playlist not found."} (calls: playlists.shared curate.setPlaylists curate.renamePlaylist)
          GET /playlists/<playlist 2>  -> "Friend's mix", 0 Sets
        execute every other capability  -> {"me":"host","failed":[],"audio":["ready","ready","ready","ready"],"collections":["Techno"]}
        "
      `);
    } finally {
      await app.dispose();
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("the catalog and search offer no delete, admin, sign-in, key, presence or editing-rights call", () => {
  const offending = catalog.filter((each) =>
    forbidden.test(`${each.path} ${each.description}`)
  );
  expect(offending.map((each) => each.path)).toEqual([]);
  expect(
    search({
      limit: 100,
      query:
        "delete remove admin sign-in signin device presence collaboration editors",
    }).results.map((each) => each.path)
  ).toEqual([]);
  expect(catalog.map((each) => each.path)).toMatchInlineSnapshot(`
    [
      "sets.list",
      "sets.read",
      "sets.tracklist",
      "sets.audioState",
      "playlists.list",
      "playlists.shared",
      "playlists.read",
      "library.tags",
      "library.heavyRotation",
      "library.collections",
      "library.collectionSets",
      "queue.read",
      "people.me",
      "people.list",
      "people.sets",
      "people.playlists",
      "people.listens",
      "curate.setTags",
      "curate.setPlaylists",
      "curate.createPlaylist",
      "curate.renamePlaylist",
      "curate.setPlaylistSets",
      "curate.createCollection",
      "curate.updateCollection",
    ]
  `);
});

test("the MCP server lists search and execute, and search answers through it", async () => {
  const listed = await Effect.runPromise(
    Effect.gen(function* listAndSearch() {
      const client = yield* McpTest.makeClient(registrations, {
        protocols: [McpProtocol.v2025_06_18],
      });
      const tools = yield* client.listTools();
      const found = yield* client.callTool({
        arguments: { namespace: "queue" },
        name: "search",
      });
      return {
        found: found.structuredContent,
        tools: new Set(tools.tools.map((tool) => tool.name)),
      };
    }).pipe(
      Effect.scoped,
      // `search` never calls Orbis, so a service that answers nothing is enough.
      Effect.provide(
        clientThrough(
          async () => await Promise.resolve(new Response(null, { status: 503 }))
        )
      )
    )
  );
  expect(listed.tools).toEqual(new Set(["execute", "search"]));
  expect(listed.found).toMatchObject({
    results: [{ path: "queue.read" }],
    total: 1,
  });
});
