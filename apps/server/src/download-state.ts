import { and, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { Context, Data, Effect } from "effect";
import { constVoid } from "effect/Function";

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

/** The action of `apps/server/models/SetDownload.tla` that each move stands for. */
type MoveName =
  | "Adopt"
  | "Cancel"
  | "Claim"
  | "Drop"
  | "Fail"
  | "Finish"
  | "Lose"
  | "Queue"
  | "Release"
  | "Requeue";

/** A move writes `to` only on a row whose state is in `from`. */
interface DownloadMove {
  readonly name: MoveName;
  readonly from: readonly StoredState[];
  readonly to: DownloadState;
}

/** One row a move changed, as the spec's trace conformance check reads it. */
export interface ObservedMove {
  readonly move: MoveName;
  readonly setId: string;
  readonly state: StoredState;
}

/**
 * Hears every row a move changes, in the order the moves run. Nothing listens in
 * production; a test sets it to record a trace for `everystate conform`.
 */
export const DownloadMoveObserver = Context.Reference<
  (move: ObservedMove) => void
>("orbis/DownloadMoveObserver", { defaultValue: () => constVoid });

/** Every move of `sets.download_state`. Nothing else writes it or the retained-audio columns. */
export const DownloadMoves = {
  /** A node reports a file it holds for a Download that is waiting or running. */
  adopt: (audio: { readonly bytes: number; readonly format: string }) =>
    ({
      from: ["queued", "downloading"],
      name: "Adopt",
      to: State.Ready(audio),
    }) satisfies DownloadMove,
  /** A ready Download is kept, so only one in another state can be canceled. */
  cancel: {
    from: notReady,
    name: "Cancel",
    to: State.None(),
  } satisfies DownloadMove,
  claim: {
    from: ["queued"],
    name: "Claim",
    to: State.Downloading(),
  } satisfies DownloadMove,
  /** A Download its requester can no longer wait for, such as a removed Person's. */
  drop: {
    from: ["queued", "downloading"],
    name: "Drop",
    to: State.None(),
  } satisfies DownloadMove,
  /** Only a running Download can fail: a cancel that won the race keeps its none. */
  fail: {
    from: ["downloading"],
    name: "Fail",
    to: State.Failed(),
  } satisfies DownloadMove,
  /**
   * Only a running Download can finish. This write is the checkpoint after the
   * file move: a cancel or release that landed first keeps the Set at none.
   */
  finish: (audio: { readonly bytes: number; readonly format: string }) =>
    ({
      from: ["downloading"],
      name: "Finish",
      to: State.Ready(audio),
    }) satisfies DownloadMove,
  /** A node's inventory no longer holds the file of a ready Download. */
  lose: {
    from: ["ready"],
    name: "Lose",
    to: State.None(),
  } satisfies DownloadMove,
  queue: {
    from: ["none", "failed", "canceled"],
    name: "Queue",
    to: State.Queued(),
  } satisfies DownloadMove,
  /** No Person keeps the Set, so its audio goes whatever its state. */
  release: {
    from: [...notReady, "ready"],
    name: "Release",
    to: State.None(),
  } satisfies DownloadMove,
  /** A restart puts a Download that was running back in the queue. */
  requeue: {
    from: ["downloading"],
    name: "Requeue",
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
 * same statement. Each changed row goes to `DownloadMoveObserver`.
 */
export const moveDownload = Effect.fn("DownloadState.move")(function* applyMove(
  client: DatabaseClient,
  move: DownloadMove,
  where?: SQL,
  also: OtherSetColumns = {}
) {
  const rows = yield* client
    .update(sets)
    .set({ ...also, ...stateColumns(move.to) })
    .where(and(where, inArray(sets.downloadState, move.from)))
    .returning();
  const observe = yield* DownloadMoveObserver;
  for (const row of rows) {
    observe({ move: move.name, setId: row.id, state: row.downloadState });
  }
  return rows;
});
