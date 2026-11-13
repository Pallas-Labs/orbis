import { Option, Schema } from "effect";

/**
 * Where a page of a friend's Listen History ends: the last Listen's
 * `startedAt` and `id`, the two keys the history is ordered by. The client
 * reads it as an opaque string.
 */
export interface ListensCursor {
  readonly id: number;
  readonly startedAt: string;
}

const CursorJson = Schema.fromJsonString(
  Schema.Tuple([Schema.String, Schema.Int])
);
const decodeCursorJson = Schema.decodeUnknownOption(CursorJson);
const encodeCursorJson = Schema.encodeSync(CursorJson);

export const encodeListensCursor = (cursor: ListensCursor): string =>
  Buffer.from(encodeCursorJson([cursor.startedAt, cursor.id])).toString(
    "base64url"
  );

/** `None` for a string this server did not write. */
export const decodeListensCursor = (
  text: string
): Option.Option<ListensCursor> =>
  Option.map(
    decodeCursorJson(Buffer.from(text, "base64url").toString("utf-8")),
    ([startedAt, id]) => ({ id, startedAt })
  );
