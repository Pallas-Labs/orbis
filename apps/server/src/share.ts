import type { SharedSet } from "@orbis/contracts";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { sets } from "./db/schema.js";
import { Database } from "./db/service.js";
import { asLibraryError, LibraryError } from "./errors.js";
import { hashToken } from "./identity.js";
import { SHARE_IMAGE_VERSION } from "./share-image/render.js";

/**
 * Reads the shared `sets` row only, never a Library Entry, so no Person's title override,
 * Tags, Playlists, or Listens can reach an Orbis Link (ADR 0023).
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
  const set: SharedSet = {
    artworkUrl: row.artworkLargeUrl ?? row.artworkUrl,
    creator: row.creator,
    id: row.id,
    source: row.source,
    title: row.title,
    url: row.url,
  };
  /** Where the preview image reads Artwork from, sharpest first. */
  const artwork = [row.artworkLargeUrl, row.artworkUrl];
  /** A short digest of everything the preview image draws, so a new one gets a new address. */
  const version = hashToken(
    JSON.stringify([
      SHARE_IMAGE_VERSION,
      row.title,
      row.creator,
      row.source,
      ...artwork,
    ])
  ).slice(0, 16);
  return { artwork, set, version };
});
