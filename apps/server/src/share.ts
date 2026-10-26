import type { SharedSet } from "@orbis/contracts";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { sets } from "./db/schema.js";
import { Database } from "./db/service.js";
import { asLibraryError, LibraryError } from "./errors.js";

/**
 * Reads the shared `sets` row only, never a Library Entry, so no Person's title override,
 * Tags, Playlists, or Listens can reach an Orbis Link (ADR 0022).
 */
export const sharedSet = Effect.fn("Share.sharedSet")(function* readSharedSet(
  id: string
) {
  const db = yield* Database;
  const [row] = yield* db
    .select({
      artworkLargeUrl: sets.artworkLargeUrl,
      artworkUrl: sets.artworkUrl,
      creator: sets.creator,
      id: sets.id,
      source: sets.source,
      title: sets.title,
      url: sets.url,
    })
    .from(sets)
    .where(eq(sets.id, id))
    .limit(1)
    .pipe(asLibraryError("Could not read the Set."));
  if (!row) {
    return yield* new LibraryError({
      message: "Set not found.",
      statusCode: 404,
    });
  }
  const shared: SharedSet = {
    artworkUrl: row.artworkLargeUrl ?? row.artworkUrl,
    creator: row.creator,
    id: row.id,
    source: row.source,
    title: row.title,
    url: row.url,
  };
  return shared;
});
