import { LibraryError } from "./errors.js";
import type { AlbumSong } from "./metadata.js";

export const appleMusicDownloadRefused = () =>
  new LibraryError({
    message:
      "Apple Music audio plays through Apple Music and is never downloaded.",
    statusCode: 400,
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
