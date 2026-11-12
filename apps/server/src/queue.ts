import type {
  ListeningQueue,
  PlaylistOrder,
  QueuePlacement,
  SavedSet,
} from "@orbis/contracts";
import { isPlayableSet } from "@orbis/contracts";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Stream } from "effect";
import { Context, Effect, Random } from "effect";

import { insertBatches } from "./db/batches.js";
import { listens, playlistSets, playlists, queueEntries } from "./db/schema.js";
import { Database } from "./db/service.js";
import type { DatabaseClient } from "./db/service.js";
import { asLibraryError, LibraryError } from "./errors.js";
import type { ListeningRange } from "./heavy-rotation.js";
import { LibraryPerson } from "./library-person.js";
import { Library } from "./library.js";
import { Presence } from "./presence.js";
import { QueueSignals } from "./queue-signals.js";

const execute = asLibraryError("Could not complete the library request.");

const notPlayable = () =>
  new LibraryError({
    message: "Only sets with audio can be added to the queue.",
    statusCode: 400,
  });

interface QueueRow {
  readonly isActive: boolean;
  readonly setId: string;
}

/** A Person's queue in order, read through the service's client or the transaction that writes it. */
const queueRows = (db: DatabaseClient, personId: string) =>
  db
    .select({
      isActive: queueEntries.isActive,
      setId: queueEntries.setId,
    })
    .from(queueEntries)
    .where(eq(queueEntries.personId, personId))
    .orderBy(asc(queueEntries.position));

const activeIn = (rows: readonly QueueRow[]) =>
  rows.find((row) => row.isActive)?.setId ?? null;

/**
 * What a queue becomes. A decision that returns `null` instead leaves the queue and its Listens
 * as they are.
 *
 * The active entry is the open Listen: a Set that becomes active opens one, and a Set that played
 * to its end closes its own. `Queue.change` writes the entries and those Listens in one
 * transaction, so no queue is stored without the Listen it stands for.
 */
interface QueueChange {
  readonly activeSetId: string | null;
  /** The Set that played to its end. Only a completion names one. */
  readonly finished?: string;
  readonly ids: readonly string[];
}

/**
 * Where a Set goes when it joins a queue behind the active entry.
 */
const placedAfter = (
  ids: readonly string[],
  id: string,
  after: string | null
) => {
  const at = after === null ? -1 : ids.indexOf(after);
  return at === -1
    ? [...ids, id]
    : [...ids.slice(0, at + 1), id, ...ids.slice(at + 1)];
};

/**
 * Where a Set goes when it takes the active place from the Set playing now.
 */
const placedBefore = (
  ids: readonly string[],
  id: string,
  before: string | null
) => {
  const at = before === null ? -1 : ids.indexOf(before);
  return at === -1 ? [...ids, id] : [...ids.slice(0, at), id, ...ids.slice(at)];
};

/**
 * Playing a Set. A Set already in the queue takes the active place without moving: the queue
 * behind it is the order the person made. A Set that is not in the queue takes the active place
 * where the listening had reached, so nothing is dropped and the Set that was playing becomes
 * what plays next.
 */
const played =
  (id: string) =>
  (rows: readonly QueueRow[]): QueueChange => {
    const ids = rows.map((row) => row.setId);
    return {
      activeSetId: id,
      ids: ids.includes(id) ? ids : placedBefore(ids, id, activeIn(rows)),
    };
  };

/**
 * Play Next or Add to Queue. Moving the Set that is playing now would leave the open Listen
 * beside a queue it no longer matches, so a queued action on the active Set changes nothing.
 */
const inserted =
  (id: string, placement: QueuePlacement) =>
  (rows: readonly QueueRow[]): QueueChange | null => {
    const activeSetId = activeIn(rows);
    if (activeSetId === id) {
      return null;
    }
    const rest = rows.map((row) => row.setId).filter((setId) => setId !== id);
    return {
      activeSetId,
      ids:
        placement === "end"
          ? [...rest, id]
          : placedAfter(rest, id, activeSetId),
    };
  };

/** A whole new queue that starts its first Set. An empty one stops playback. */
const replaced = (ids: readonly string[]) => (): QueueChange => ({
  activeSetId: ids[0] ?? null,
  ids,
});

/**
 * The active Set played to its end: it leaves the queue and what followed it starts. A Set that
 * is not the active one was already finished, or the person started something else while it
 * played. Either way the signal changes nothing, which is what makes a retried one safe.
 */
const completed =
  (id: string) =>
  (rows: readonly QueueRow[]): QueueChange | null => {
    const at = rows.findIndex((row) => row.isActive && row.setId === id);
    if (at === -1) {
      return null;
    }
    const ids = rows.map((row) => row.setId);
    return {
      activeSetId: ids[at + 1] ?? null,
      finished: id,
      ids: ids.filter((setId) => setId !== id),
    };
  };

/**
 * One Person's Listening Queue, and the Listen it keeps open.
 *
 * An entry is a Set waiting to play, and the entry marked active is the Set playing now. The
 * queue is the whole of the playback state: which Set is playing, what follows it, and — because
 * the active entry is the Listen — whether a completion signal is the first one for this Listen.
 * Counting from a stored state rather than from reported events is what makes a retried signal
 * from the other device do nothing.
 */
export class Queue extends Context.Service<
  Queue,
  {
    readonly changes: Stream.Stream<boolean>;
    readonly notify: Effect.Effect<void>;
    readonly read: Effect.Effect<ListeningQueue, LibraryError>;
    /** Makes a Set the active one, which is what tapping a playable Set does. */
    readonly play: (id: string) => Effect.Effect<ListeningQueue, LibraryError>;
    readonly insert: (
      id: string,
      placement: QueuePlacement
    ) => Effect.Effect<ListeningQueue, LibraryError>;
    /** Replaces the whole queue with a Playlist's playable members and starts the first. */
    readonly replaceWithPlaylist: (
      playlistId: string,
      creatorId?: string,
      order?: PlaylistOrder
    ) => Effect.Effect<ListeningQueue, LibraryError>;
    /** Replaces the queue with the playable Sets in Heavy Rotation over a range. */
    readonly replaceWithHeavyRotation: (
      range: ListeningRange,
      order?: "ranked" | "shuffled"
    ) => Effect.Effect<ListeningQueue, LibraryError>;
    /** Replaces the queue with the playable Sets in one of this Person's Collections. */
    readonly replaceWithCollection: (
      collectionId: string,
      order?: "ranked" | "shuffled"
    ) => Effect.Effect<ListeningQueue, LibraryError>;
    /** Removes the finished Set, resets its position, and starts what followed it. */
    readonly complete: (
      id: string
    ) => Effect.Effect<ListeningQueue, LibraryError>;
  }
>()("@orbis/Queue") {
  static readonly make = Effect.gen(function* buildQueue() {
    const db = yield* Database;
    const library = yield* Library;
    const presence = yield* Presence;
    const personId = yield* LibraryPerson;
    const signals = yield* QueueSignals;
    const notify = signals.publish(personId);

    const read = Effect.gen(function* readQueue() {
      const rows = yield* execute(queueRows(db, personId));
      return {
        activeSetId: activeIn(rows),
        entries: yield* library.byIds(rows.map((row) => row.setId)),
      } satisfies ListeningQueue;
    }).pipe(Effect.withSpan("Queue.read"));

    /** Closes this Person's newest open Listen of a Set. */
    const finishListen = Effect.fn("Queue.finishListen")(
      function* finishLatestListen(
        tx: DatabaseClient,
        setId: string,
        at: string
      ) {
        const [latest] = yield* tx
          .select({ id: listens.id })
          .from(listens)
          .where(
            and(
              eq(listens.personId, personId),
              eq(listens.setId, setId),
              isNull(listens.finishedAt)
            )
          )
          .orderBy(desc(listens.id))
          .limit(1);
        if (latest) {
          yield* tx
            .update(listens)
            .set({ finishedAt: at })
            .where(eq(listens.id, latest.id));
        }
      }
    );

    // The one writer of the queue and of the Listens it stands for. The decision reads the stored
    // queue inside the transaction that writes it, so the entries, the Finish and the new Listen
    // commit together or not at all.
    //
    // Every change states the whole queue. One person's queue is small, the write is one
    // transaction, and positions stay consecutive instead of drifting into gaps that need
    // renumbering later.
    const change = Effect.fn("Queue.change")(function* changeQueue(
      decide: (rows: readonly QueueRow[]) => QueueChange | null
    ) {
      const left = yield* execute(
        db.transaction((tx) =>
          Effect.gen(function* changeQueueTransaction() {
            const rows = yield* queueRows(tx, personId);
            const next = decide(rows);
            if (next === null) {
              return null;
            }
            const at = new Date().toISOString();
            yield* presence.queueActivated(tx, personId, next.activeSetId);
            yield* tx
              .delete(queueEntries)
              .where(eq(queueEntries.personId, personId));
            const entries = next.ids.map((setId, position) => ({
              isActive: setId === next.activeSetId,
              personId,
              position,
              setId,
            }));
            for (const batch of insertBatches(queueEntries, entries)) {
              yield* tx.insert(queueEntries).values(batch);
            }
            if (next.finished !== undefined) {
              yield* finishListen(tx, next.finished, at);
            }
            if (
              next.activeSetId !== null &&
              next.activeSetId !== activeIn(rows)
            ) {
              yield* tx
                .insert(listens)
                .values({ personId, setId: next.activeSetId, startedAt: at });
            }
            return rows
              .map((row) => row.setId)
              .filter((setId) => !next.ids.includes(setId));
          })
        )
      );
      if (left === null) {
        return;
      }
      yield* presence.afterCommit;
      // A Set that left the queue may have been kept only by it. Its audio goes after the
      // commit: a release that fails leaves the queue and its Listens whole.
      yield* Effect.forEach((setId: string) => library.release(setId))(left);
    });

    // The one check that keeps an unplayable Set out of the queue. A Playlist is filtered
    // instead, because a Playlist is not wrong to play just because one member has no audio.
    const playable = Effect.fn("Queue.playable")(function* requirePlayable(
      id: string
    ) {
      const [set] = yield* library.byIds([id]);
      if (!set) {
        return yield* Effect.fail(
          new LibraryError({ message: "Set not found.", statusCode: 404 })
        );
      }
      if (!isPlayableSet(set)) {
        return yield* Effect.fail(notPlayable());
      }
      return set;
    });

    const play = Effect.fn("Queue.play")((id: string) =>
      Effect.gen(function* playSet() {
        yield* playable(id);
        yield* change(played(id));
        return yield* read.pipe(Effect.tap(notify));
      })
    );

    const insert = Effect.fn("Queue.insert")(
      (id: string, placement: QueuePlacement) =>
        Effect.gen(function* insertEntry() {
          yield* playable(id);
          yield* change(inserted(id, placement));
          return yield* read.pipe(Effect.tap(notify));
        })
    );

    /** Replaces the queue with the playable Sets among `members`, in their order or shuffled. */
    const replaceWithSets = Effect.fn("Queue.replaceWithSets")(
      (members: readonly SavedSet[], shuffled: boolean) =>
        Effect.gen(function* replaceQueueWithSets() {
          const playableIds = members
            .filter(isPlayableSet)
            .map((set) => set.id);
          const ids = shuffled
            ? yield* Random.shuffle(playableIds)
            : playableIds;
          yield* change(replaced(ids));
          return yield* read.pipe(Effect.tap(notify));
        })
    );

    const replaceWithPlaylist = Effect.fn("Queue.replaceWithPlaylist")(
      (
        playlistId: string,
        creatorId: string = personId,
        playlistOrder: PlaylistOrder = "playlist"
      ) =>
        Effect.gen(function* replaceQueueFromPlaylist() {
          const [playlist] = yield* execute(
            db
              .select({ id: playlists.id })
              .from(playlists)
              .where(
                and(
                  eq(playlists.id, playlistId),
                  eq(playlists.creatorId, creatorId)
                )
              )
              .limit(1)
          );
          if (!playlist) {
            return yield* Effect.fail(
              new LibraryError({
                message: "Playlist not found.",
                statusCode: 404,
              })
            );
          }
          const memberIds = yield* execute(
            db
              .select({ setId: playlistSets.setId })
              .from(playlistSets)
              .where(eq(playlistSets.playlistId, playlistId))
              .orderBy(asc(playlistSets.position))
          );
          const members = yield* library.byIds(
            memberIds.map((member) => member.setId)
          );
          return yield* replaceWithSets(members, playlistOrder === "shuffled");
        })
    );

    const replaceWithCollection = Effect.fn("Queue.replaceWithCollection")(
      (
        collectionId: string,
        collectionOrder: "ranked" | "shuffled" = "ranked"
      ) =>
        Effect.gen(function* replaceQueueFromCollection() {
          const members = yield* library.collectionSets(collectionId);
          return yield* replaceWithSets(
            members,
            collectionOrder === "shuffled"
          );
        })
    );

    const replaceWithHeavyRotation = Effect.fn(
      "Queue.replaceWithHeavyRotation"
    )(
      (
        range: ListeningRange,
        rotationOrder: "ranked" | "shuffled" = "ranked"
      ) =>
        Effect.gen(function* replaceQueueFromHeavyRotation() {
          const members = yield* library.heavyRotation(range);
          return yield* replaceWithSets(members, rotationOrder === "shuffled");
        })
    );

    const complete = Effect.fn("Queue.complete")((id: string) =>
      Effect.gen(function* completeSet() {
        // The position resets before the queue moves, and only for the active Set. A request
        // that stops between the two is retried against a Set that is still active.
        if (completed(id)(yield* execute(queueRows(db, personId))) !== null) {
          yield* library.setPlaybackPosition(id, 0);
          yield* change(completed(id));
        }
        return yield* read.pipe(Effect.tap(notify));
      })
    );

    return Queue.of({
      changes: signals.subscribe(personId),
      complete,
      insert,
      notify,
      play,
      read,
      replaceWithCollection,
      replaceWithHeavyRotation,
      replaceWithPlaylist,
    });
  });

  /** Builds one Person's Queue for a request, which provides it with `Effect.provideService`. */
  static forPerson(personId: string) {
    return Queue.make.pipe(Effect.provideService(LibraryPerson, personId));
  }
}
