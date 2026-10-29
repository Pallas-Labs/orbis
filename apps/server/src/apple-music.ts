import type { AppleMusicGroupKind } from "@orbis/contracts/http-api";

import { LibraryError } from "./errors.js";
import type { MetadataError } from "./metadata-error.js";
import type { AlbumSong, AppleMusicSearchAlbum } from "./metadata.js";

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
 * Each song's start, the sum of the lengths before it. The running total is kept unrounded and
 * each start is rounded on its own, so rounding never accumulates across a long mix. After a song
 * Apple gives no length for, no later start is known.
 */
export const songStarts = (songs: readonly AlbumSong[]): (number | null)[] => {
  let elapsed: number | null = 0;
  return songs.map((song) => {
    const start = elapsed === null ? null : Math.round(elapsed);
    elapsed =
      elapsed === null || song.durationSeconds === null
        ? null
        : elapsed + song.durationSeconds;
    return start;
  });
};

/** One Cue per song, in album order, at the song's start. */
export const albumCues = (setId: string, songs: readonly AlbumSong[]) => {
  const starts = songStarts(songs);
  return songs.map((song, position) => ({
    appleMusicId: song.appleMusicId,
    artist: song.artist,
    artworkUrl: song.artworkUrl,
    position,
    setId,
    startSeconds: starts[position] ?? null,
    title: song.title,
  }));
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

/** The mix series Orbis knows by name. A DJ mix whose title starts with one belongs to it. */
const MIX_SERIES = [
  "DJ-Kicks",
  "fabric",
  "FABRICLIVE",
  "Essential Mix",
  "Late Night Tales",
  "Balance",
  "Global Underground",
  "Back to Mine",
  "Boiler Room",
];

/** Lower case, with each run of punctuation and spaces as one space, so "DJ - Kicks" is "dj kicks". */
const nameKey = (name: string) =>
  name
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * The known series a title starts with, as whole words: "fabric 100" is fabric, "FABRICLIVE 50"
 * is FABRICLIVE, and "Stellar Fountain's Essential Mix" is no series.
 */
export const mixSeries = (title: string): string | null => {
  const key = nameKey(title);
  return (
    MIX_SERIES.find((series) => {
      const prefix = nameKey(series);
      return key === prefix || key.startsWith(`${prefix} `);
    }) ?? null
  );
};

type GroupKind = typeof AppleMusicGroupKind.Type;

const NOT_A_DJ = nameKey("Various Artists");

const groupName: Record<
  GroupKind,
  (album: AppleMusicSearchAlbum) => string | null
> = {
  dj: (album) =>
    album.creator && nameKey(album.creator) !== NOT_A_DJ ? album.creator : null,
  label: (album) => album.recordLabel,
  series: (album) => album.series,
};

/** The groups of one kind among the mixes, largest first, then in Apple's order. */
const groupsOf = (kind: GroupKind, mixes: readonly AppleMusicSearchAlbum[]) => {
  const groups = new Map<
    string,
    { albumCount: number; artworkUrl: string | null; name: string }
  >();
  for (const album of mixes) {
    const name = groupName[kind](album);
    if (name) {
      const key = nameKey(name);
      const group = groups.get(key) ?? {
        albumCount: 0,
        artworkUrl: album.artworkUrl,
        name,
      };
      group.albumCount += 1;
      groups.set(key, group);
    }
  }
  const largestFirst = [...groups.values()];
  largestFirst.sort((a, b) => b.albumCount - a.albumCount);
  return largestFirst;
};

type Group = ReturnType<typeof groupsOf>[number];

/** The series, DJ, or label, in that order, whose name is the words. */
const topResult = (
  words: string,
  groups: { djs: Group[]; labels: Group[]; series: Group[] }
) => {
  const key = nameKey(words);
  for (const [kind, list] of [
    ["series", groups.series],
    ["dj", groups.djs],
    ["label", groups.labels],
  ] as const) {
    const group = list.find((candidate) => nameKey(candidate.name) === key);
    if (group) {
      return { kind, name: group.name };
    }
  }
  return null;
};

/** The group a search narrows to; each key names a group by its name, ignoring case. */
export interface AppleMusicNarrowing {
  readonly creator?: string | undefined;
  readonly label?: string | undefined;
  readonly series?: string | undefined;
}

const NARROWED_BY = {
  creator: "dj",
  label: "label",
  series: "series",
} as const;

/**
 * The answer to a search: the albums, narrowed to one group's DJ mixes newest first when asked,
 * and the groups and Top Result of the whole search, built from its DJ mixes only.
 */
export const appleMusicSearchAnswer = (
  words: string,
  found: readonly AppleMusicSearchAlbum[],
  narrowing: AppleMusicNarrowing
) => {
  const mixes = found.filter((album) => album.djMix);
  const groups = {
    djs: groupsOf("dj", mixes),
    labels: groupsOf("label", mixes),
    series: groupsOf("series", mixes),
  };
  const asked = (["creator", "label", "series"] as const).flatMap((key) => {
    const name = nameKey(narrowing[key] ?? "");
    return name ? [{ kind: NARROWED_BY[key], name }] : [];
  });
  const inGroups = (album: AppleMusicSearchAlbum) =>
    asked.every(({ kind, name }) => {
      const value = groupName[kind](album);
      return value !== null && nameKey(value) === name;
    });
  const narrowed = mixes.filter(inGroups);
  narrowed.sort((a, b) =>
    (b.releasedAt ?? "").localeCompare(a.releasedAt ?? "")
  );
  return {
    albums: asked.length === 0 ? found : narrowed,
    groups,
    top: topResult(words, groups),
  };
};
