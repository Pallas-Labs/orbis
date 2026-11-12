// Collections through `createApp` over HTTP with a real database.
//
// Ways it could fail:
// - A filter (Tag, creator, source, range, heard at least) admits a Set it
//   should not, or drops one it should.
// - A Collection hides itself under three Sets, as Heavy Rotation does.
// - A Tag filter matches only the exact case the Person typed.
// - Two Collections share a name, a blank name is saved, or a creator id with
//   no Set behind it is saved.
// - Editing a Collection keeps its old filter.
// - Playing a Collection queues Sets in another order, or Sets outside it.
// - Another Person lists, reads, plays, edits or deletes this Person's
//   Collections.
// - A deleted Collection still answers.
//
// The transcript prints each answer, so a change to these rules shows in its
// snapshot diff.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CollectionSchema,
  LibraryResponseSchema,
  ListeningQueueSchema,
} from "@orbis/contracts/http-api";
import { Schema } from "effect";

import { hashToken } from "./identity.js";
import { createTestApp as createApp } from "./test-app.js";
import { request, runInOrder, transcript } from "./test-http.js";
import { ready, seedSets } from "./test-library.js";

const decodeCollection = Schema.decodeUnknownSync(CollectionSchema);
const decodeCollections = Schema.decodeUnknownSync(
  Schema.Struct({ collections: Schema.Array(CollectionSchema) })
);
const decodeSets = Schema.decodeUnknownSync(LibraryResponseSchema);
const decodeQueue = Schema.decodeUnknownSync(
  Schema.Struct({ queue: ListeningQueueSchema })
);
const decodeRefusal = Schema.decodeUnknownSync(
  Schema.Struct({ message: Schema.String })
);

const OTHER_TOKEN = "other-key";

interface Filter {
  readonly creatorId?: string | null;
  readonly minimumMinutes?: number;
  readonly name: string;
  readonly range?: "month" | "quarter" | "year";
  readonly source?: "youtube" | "soundcloud" | "apple-music" | null;
  readonly tag?: string | null;
}

/** A whole payload: a filter left out admits every Set. */
const payload = (filter: Filter) => ({
  creatorId: filter.creatorId ?? null,
  minimumMinutes: filter.minimumMinutes ?? 0,
  name: filter.name,
  range: filter.range ?? "month",
  source: filter.source ?? null,
  tag: filter.tag ?? null,
});

test("transcript: Collections filter listening, and stay their Person's own", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-collections-"));
  const databasePath = path.join(directory, "library.sqlite");
  const devicesPath = path.join(directory, "devices.json");
  try {
    await writeFile(
      devicesPath,
      JSON.stringify({
        keys: [
          {
            addedAt: "2026-11-01T00:00:00.000Z",
            id: "other-key",
            label: "test",
            lastUsedAt: null,
            personId: "other",
            scope: "daily",
            tokenHash: hashToken(OTHER_TOKEN),
          },
        ],
        people: [
          { id: "host", removed: false, username: "host" },
          { id: "other", removed: false, username: "other" },
        ],
        version: 2,
      })
    );
    await seedSets(databasePath, ready(["a", "b", "c", "d", "e"]));
    const seed = new Database(databasePath);
    try {
      const describe = seed.query(
        "UPDATE sets SET source = ?, creator_id = ?, creator = ? WHERE id = ?"
      );
      describe.run("youtube", "dj-x", "DJ X", "a");
      describe.run("soundcloud", "dj-x", "DJ X", "b");
      describe.run("youtube", "dj-y", "DJ Y", "c");
      describe.run("apple-music", null, null, "d");
      describe.run("youtube", "dj-y", "DJ Y", "e");
      seed.run(
        `UPDATE library_entries SET tags = '["techno"]' WHERE person_id = 'host' AND set_id IN ('a', 'e')`
      );
      const heard = seed.query(
        "INSERT INTO listening_time (person_id, day, set_id, seconds) VALUES ('host', date('now', ?), ?, ?)"
      );
      heard.run("+0 days", "a", 7200);
      heard.run("+0 days", "b", 3600);
      heard.run("+0 days", "c", 1800);
      heard.run("-60 days", "d", 10_800);
      heard.run("+0 days", "e", 600);
    } finally {
      seed.close();
    }

    const app = createApp({ databasePath, devicesPath });
    try {
      const t = transcript();
      const ids = new Map<string, string>();

      type Payload = ReturnType<typeof payload> | { collectionId: string };
      const call = (
        method: string,
        url: string,
        body?: Payload,
        who: "host" | "other" = "host"
      ) => {
        const options: Parameters<typeof request>[1] = {
          method,
          payload: body,
          url,
        };
        if (who === "other") {
          options.headers = { authorization: `Bearer ${OTHER_TOKEN}` };
        }
        return request(app, options);
      };

      /** One answer as a line: the Collection, the Sets, or the refusal. */
      const said = (response: Awaited<ReturnType<typeof call>>) => {
        const body = response.json();
        if (response.statusCode >= 400) {
          return `${response.statusCode} ${decodeRefusal(body).message}`;
        }
        return `${response.statusCode}`;
      };

      const create = async (filter: Filter) => {
        const response = await call("POST", "/collections", payload(filter));
        if (response.statusCode !== 201) {
          return said(response);
        }
        const collection = decodeCollection(response.json());
        ids.set(collection.name, collection.id);
        return `${response.statusCode} ${collection.name}: ${collection.range}, tag ${collection.tag}, creator ${collection.creator}, source ${collection.source}, ${collection.minimumMinutes} min`;
      };

      const setsOf = async (name: string, who: "host" | "other" = "host") => {
        const response = await call(
          "GET",
          `/collections/${ids.get(name) ?? "missing"}/sets`,
          undefined,
          who
        );
        if (response.statusCode !== 200) {
          return said(response);
        }
        const { sets } = decodeSets(response.json());
        return `200 ${sets.length === 0 ? "(empty)" : sets.map((set) => set.id).join(" ")}`;
      };

      const names = async (who: "host" | "other" = "host") => {
        const response = await call("GET", "/collections", undefined, who);
        const { collections } = decodeCollections(response.json());
        return `${response.statusCode} ${collections.length === 0 ? "(none)" : collections.map((collection) => collection.name).join(", ")}`;
      };

      t.step("list", await names());

      await runInOrder(
        [
          { name: "Techno", tag: "Techno" },
          { creatorId: "dj-x", name: "DJ X" },
          { name: "SoundCloud", source: "soundcloud" },
          { minimumMinutes: 60, name: "Long listens" },
          { name: "Apple Music", source: "apple-music" },
          {
            name: "Apple Music, 3 months",
            range: "quarter",
            source: "apple-music",
          },
        ] satisfies Filter[],
        async (filter) => {
          t.step(`create ${filter.name}`, await create(filter));
          t.step(`  sets`, await setsOf(filter.name));
        }
      );

      t.step("create Techno again", await create({ name: "techno" }));
      t.step("create a blank name", await create({ name: "  " }));
      t.step(
        "create with a creator no Set has",
        await create({ creatorId: "nobody", name: "Nobody" })
      );

      const edited = await call(
        "PATCH",
        `/collections/${ids.get("Long listens")}`,
        payload({ minimumMinutes: 120, name: "Long listens" })
      );
      t.step("edit Long listens to 2 h", said(edited));
      t.step("  sets", await setsOf("Long listens"));
      const renamed = await call(
        "PATCH",
        `/collections/${ids.get("Long listens")}`,
        payload({ name: "DJ X" })
      );
      t.step("rename Long listens to DJ X", said(renamed));

      const played = await call("PUT", "/queue/collection", {
        collectionId: ids.get("DJ X") ?? "missing",
      });
      const { queue } = decodeQueue(played.json());
      t.step(
        "play DJ X",
        `${played.statusCode} ${queue.entries.map((set) => set.id).join(" ")}, active ${queue.activeSetId}`
      );

      t.step("other lists", await names("other"));
      t.step("other reads DJ X", await setsOf("DJ X", "other"));
      const otherPlays = await call(
        "PUT",
        "/queue/collection",
        { collectionId: ids.get("DJ X") ?? "missing" },
        "other"
      );
      t.step("other plays DJ X", said(otherPlays));
      const otherEdits = await call(
        "PATCH",
        `/collections/${ids.get("DJ X")}`,
        payload({ name: "Mine now" }),
        "other"
      );
      t.step("other edits DJ X", said(otherEdits));
      const otherDeletes = await call(
        "DELETE",
        `/collections/${ids.get("DJ X")}`,
        undefined,
        "other"
      );
      t.step("other deletes DJ X", said(otherDeletes));

      const removed = await call(
        "DELETE",
        `/collections/${ids.get("SoundCloud")}`
      );
      t.step("delete SoundCloud", said(removed));
      t.step("  sets", await setsOf("SoundCloud"));
      t.step("list", await names());

      expect(t.text()).toMatchInlineSnapshot(`
        "
        list  -> 200 (none)
        create Techno  -> 201 Techno: month, tag techno, creator null, source null, 0 min
          sets  -> 200 a e
        create DJ X  -> 201 DJ X: month, tag null, creator DJ X, source null, 0 min
          sets  -> 200 a b
        create SoundCloud  -> 201 SoundCloud: month, tag null, creator null, source soundcloud, 0 min
          sets  -> 200 b
        create Long listens  -> 201 Long listens: month, tag null, creator null, source null, 60 min
          sets  -> 200 a b
        create Apple Music  -> 201 Apple Music: month, tag null, creator null, source apple-music, 0 min
          sets  -> 200 (empty)
        create Apple Music, 3 months  -> 201 Apple Music, 3 months: quarter, tag null, creator null, source apple-music, 0 min
          sets  -> 200 d
        create Techno again  -> 409 A collection with this name already exists.
        create a blank name  -> 400 Enter a collection name.
        create with a creator no Set has  -> 400 No Set is by that creator.
        edit Long listens to 2 h  -> 200
          sets  -> 200 a
        rename Long listens to DJ X  -> 409 A collection with this name already exists.
        play DJ X  -> 200 a b, active a
        other lists  -> 200 (none)
        other reads DJ X  -> 404 Collection not found.
        other plays DJ X  -> 404 Collection not found.
        other edits DJ X  -> 404 Collection not found.
        other deletes DJ X  -> 404 Collection not found.
        delete SoundCloud  -> 200
          sets  -> 404 Collection not found.
        list  -> 200 Apple Music, Apple Music, 3 months, DJ X, Long listens, Techno
        "
      `);
    } finally {
      await app.dispose();
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
