import { eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";

import { libraryEntries, sets } from "./db/schema.js";
import { Database } from "./db/service.js";
import { LibraryError } from "./errors.js";
import type { PersonRecord } from "./identity.js";

const hidden = () =>
  new LibraryError({ message: "Person not found.", statusCode: 404 });

export const resolveVisiblePerson = (
  people: readonly PersonRecord[],
  viewerId: string,
  targetId: string
): PersonRecord => {
  const viewer = people.find((person) => person.id === viewerId);
  const target = people.find((person) => person.id === targetId);
  if (
    !viewer ||
    !target ||
    viewer.id === target.id ||
    viewer.removed ||
    target.removed ||
    viewer.social !== true ||
    target.social !== true ||
    viewer.filters?.find((filter) => filter.personId === target.id)?.see ===
      false ||
    target.filters?.find((filter) => filter.personId === viewer.id)?.appear ===
      false
  ) {
    throw hidden();
  }
  return target;
};

/**
 * The People the viewer would see if their own See filter allowed it, with the
 * viewer's See and Appear filters for each. Setting See off must not drop a Person
 * from this list, or the viewer could never turn it back on; everything else in
 * the gate still applies, so a Person who hid from the viewer stays hidden.
 */
export const listFilterablePeople = (
  people: readonly PersonRecord[],
  viewerId: string
) => {
  const viewer = people.find((person) => person.id === viewerId);
  if (!viewer) {
    return [];
  }
  const seeingAll = people.map((person) =>
    person.id === viewerId
      ? {
          ...person,
          filters: (person.filters ?? []).map((filter) => ({
            ...filter,
            see: true,
          })),
        }
      : person
  );
  return people.flatMap((person) => {
    try {
      resolveVisiblePerson(seeingAll, viewerId, person.id);
    } catch {
      return [];
    }
    const filter = viewer.filters?.find((item) => item.personId === person.id);
    return [
      {
        appear: filter?.appear ?? true,
        id: person.id,
        see: filter?.see ?? true,
        username: person.username,
      },
    ];
  });
};

const notFound = () =>
  new LibraryError({ message: "Set not found.", statusCode: 404 });

type SetRow = typeof sets.$inferSelect;

const canSee = (
  people: readonly PersonRecord[],
  viewerId: string,
  targetId: string
) => {
  try {
    resolveVisiblePerson(people, viewerId, targetId);
    return true;
  } catch {
    return false;
  }
};

/**
 * Which of these Sets the Person can see: one in their own Library, a host Set no one has
 * a Library entry for, one they queued or put in their own playlist, or one in the Library
 * of another Person visible to them. Three reads at most, however many Sets.
 */
export const visibleSetIds = Effect.fn("Visibility.visibleSetIds")(
  function* visibleSets(input: {
    readonly rows: readonly Pick<SetRow, "id" | "hostRemoved">[];
    readonly personId: string;
    readonly people: readonly PersonRecord[];
  }) {
    const visible = new Set<string>();
    if (input.rows.length === 0) {
      return visible;
    }
    const db = yield* Database;
    const entries = yield* db
      .select({
        personId: libraryEntries.personId,
        setId: libraryEntries.setId,
      })
      .from(libraryEntries)
      .where(
        inArray(
          libraryEntries.setId,
          input.rows.map((row) => row.id)
        )
      );
    const held = new Set(entries.map((entry) => entry.setId));
    for (const entry of entries) {
      if (entry.personId === input.personId) {
        visible.add(entry.setId);
      }
    }
    for (const row of input.rows) {
      if (input.personId === "host" && !row.hostRemoved && !held.has(row.id)) {
        visible.add(row.id);
      }
    }
    const pending = input.rows.filter((row) => !visible.has(row.id));
    if (pending.length === 0) {
      return visible;
    }
    const pendingIds = sql.join(
      pending.map((row) => sql`${row.id}`),
      sql`, `
    );
    const owned = yield* db.all<{ readonly setId: string }>(sql`
    SELECT set_id AS setId FROM queue_entries
      WHERE person_id = ${input.personId} AND set_id IN (${pendingIds})
    UNION
    SELECT playlist_sets.set_id AS setId FROM playlist_sets
      INNER JOIN playlists ON playlists.id = playlist_sets.playlist_id
      WHERE playlists.creator_id = ${input.personId} AND playlist_sets.set_id IN (${pendingIds})
  `);
    for (const row of owned) {
      visible.add(row.setId);
    }
    for (const entry of entries) {
      if (visible.has(entry.setId)) {
        continue;
      }
      if (canSee(input.people, input.personId, entry.personId)) {
        visible.add(entry.setId);
      }
    }
    return visible;
  }
);

/** Resolves a Set through an owned reference or another visible Person's Library. */
export const resolveVisibleSet = Effect.fn("Visibility.resolveSet")(
  function* resolveSet(input: {
    readonly id: string;
    readonly personId: string;
    readonly people: readonly PersonRecord[];
  }) {
    const db = yield* Database;
    const [row] = yield* db.select().from(sets).where(eq(sets.id, input.id));
    if (!row) {
      return yield* Effect.fail(notFound());
    }
    const visible = yield* visibleSetIds({
      people: input.people,
      personId: input.personId,
      rows: [row],
    });
    if (!visible.has(row.id)) {
      return yield* Effect.fail(notFound());
    }
    return row;
  }
);
