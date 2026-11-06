import { and, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { Data } from "effect";

import { sets } from "./db/schema.js";
import type { DatabaseClient } from "./db/service.js";

/** Where a Set's Download stands. Only a ready Download holds retained audio. */
export type DownloadState = Data.TaggedEnum<{
  None: Record<never, never>;
  Queued: Record<never, never>;
  Downloading: Record<never, never>;
  Ready: { readonly bytes: number; readonly format: string };
  Failed: Record<never, never>;
}>;
const State = Data.taggedEnum<DownloadState>();

type StoredState = (typeof sets.$inferSelect)["downloadState"];

// `canceled` is a stored value that nothing writes any more; a move may leave it.
const notReady: readonly StoredState[] = [
  "none",
  "queued",
  "downloading",
  "failed",
  "canceled",
];

/** A move writes `to` only on a row whose state is in `from`. */
interface DownloadMove {
  readonly from: readonly StoredState[];
  readonly to: DownloadState;
}

/** Every move of `sets.download_state`. Nothing else writes it or the retained-audio columns. */
export const DownloadMoves = {
  /** A node reports a file it holds for a Download that is waiting or running. */
  adopt: (audio: { readonly bytes: number; readonly format: string }) =>
    ({
      from: ["queued", "downloading"],
      to: State.Ready(audio),
    }) satisfies DownloadMove,
  /** A ready Download is kept, so only one in another state can be canceled. */
  cancel: { from: notReady, to: State.None() } satisfies DownloadMove,
  claim: { from: ["queued"], to: State.Downloading() } satisfies DownloadMove,
  /** A Download its requester can no longer wait for, such as a removed Person's. */
  drop: {
    from: ["queued", "downloading"],
    to: State.None(),
  } satisfies DownloadMove,
  /** Only a running Download can fail: a cancel that won the race keeps its none. */
  fail: { from: ["downloading"], to: State.Failed() } satisfies DownloadMove,
  /**
   * Only a running Download can finish. This write is the checkpoint after the
   * file move: a cancel or release that landed first keeps the Set at none.
   */
  finish: (audio: { readonly bytes: number; readonly format: string }) =>
    ({
      from: ["downloading"],
      to: State.Ready(audio),
    }) satisfies DownloadMove,
  /** A node's inventory no longer holds the file of a ready Download. */
  lose: { from: ["ready"], to: State.None() } satisfies DownloadMove,
  queue: {
    from: ["none", "failed", "canceled"],
    to: State.Queued(),
  } satisfies DownloadMove,
  /** No Person keeps the Set, so its audio goes whatever its state. */
  release: {
    from: [...notReady, "ready"],
    to: State.None(),
  } satisfies DownloadMove,
  /** A restart puts a Download that was running back in the queue. */
  requeue: {
    from: ["downloading"],
    to: State.Queued(),
  } satisfies DownloadMove,
};

const stateColumns = (state: DownloadState) =>
  State.$match(state, {
    Downloading: () => ({ downloadState: "downloading" as const }),
    Failed: () => ({ downloadState: "failed" as const }),
    None: () => ({
      downloadState: "none" as const,
      retainedAudioBytes: null,
      retainedAudioFormat: null,
    }),
    Queued: () => ({ downloadState: "queued" as const }),
    Ready: ({ bytes, format }) => ({
      downloadState: "ready" as const,
      retainedAudioBytes: bytes,
      retainedAudioFormat: format,
    }),
  });

type OtherSetColumns = Omit<
  Partial<typeof sets.$inferInsert>,
  "downloadState" | "retainedAudioBytes" | "retainedAudioFormat"
>;

/**
 * The one writer of a Set's Download. It is a compare-and-set: rows that
 * `where` selects (every row when it is absent) change only when their state is one the move leaves, and the
 * changed rows come back. `also` writes other columns of those rows in the
 * same statement.
 */
export const moveDownload = (
  client: DatabaseClient,
  move: DownloadMove,
  where?: SQL,
  also: OtherSetColumns = {}
) =>
  client
    .update(sets)
    .set({ ...also, ...stateColumns(move.to) })
    .where(and(where, inArray(sets.downloadState, move.from)))
    .returning();
