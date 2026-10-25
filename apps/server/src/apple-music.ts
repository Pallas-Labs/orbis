import { LibraryError } from "./errors.js";
import type { MetadataError } from "./metadata-error.js";
import type { AlbumSong } from "./metadata.js";

export const appleMusicDownloadRefused = () =>
  new LibraryError({
    message:
      "Apple Music audio plays through Apple Music and is never downloaded.",
    statusCode: 400,
  });

export const appleMusicSearchRefusal = (error: MetadataError) =>
  new LibraryError({
    message:
      error.reason === "not-configured"
        ? "Apple Music search is not set up on this server."
        : "Apple Music is not answering. Try the search again.",
    statusCode: 503,
  });

/**
 * One Cue per song, in album order, starting at the sum of the lengths before it. The running
 * total is kept unrounded and each start is rounded on its own, so rounding never accumulates
 * across a long mix. After a song Apple gives no length for, no later start is known.
 */
export const albumCues = (setId: string, songs: readonly AlbumSong[]) => {
  let elapsed: number | null = 0;
  return songs.map((song, position) => {
    const startSeconds = elapsed === null ? null : Math.round(elapsed);
    elapsed =
      elapsed === null || song.durationSeconds === null
        ? null
        : elapsed + song.durationSeconds;
    return {
      appleMusicId: song.appleMusicId,
      artist: song.artist,
      artworkUrl: song.artworkUrl,
      position,
      setId,
      startSeconds,
      title: song.title,
    };
  });
};

/** What the DJ-mix rule reads from an album. */
export interface AlbumFacts {
  /** Apple's short and standard notes together; empty when it has none. */
  readonly editorialNotes: string;
  readonly isSingle: boolean;
  readonly songTitles: readonly string[];
  readonly title: string;
}

const MIX_WORDS = ["dj mix", "mixed by", "continuous mix"];
/** "(Mixed)", "[Mixed]", or a bracket that closes on it, as in "(Espen Remix - Mixed)". */
const MIXED_MARK = /\bmixed[)\]]/iu;

const namesMix = (text: string) =>
  MIX_WORDS.some((words) => text.toLowerCase().includes(words));

/**
 * Whether an album looks like a DJ mix. The Apple Music API has no such flag, so this reads the
 * names Apple gives the mixes it carries (ADR 0021). It only ranks and filters search; a save
 * never asks it.
 */
export const isDjMix = (album: AlbumFacts): boolean => {
  if (album.isSingle) {
    return false;
  }
  if (namesMix(album.title) || MIXED_MARK.test(album.title)) {
    return true;
  }
  const mixed = album.songTitles.filter((title) =>
    MIXED_MARK.test(title)
  ).length;
  if (album.songTitles.length > 0 && mixed * 2 >= album.songTitles.length) {
    return true;
  }
  return namesMix(album.editorialNotes);
};
