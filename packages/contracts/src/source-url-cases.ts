import type { SetSource } from "./index.js";

/**
 * A URL a client must accept, with the canonical Source Link and source it must produce.
 * Both the server and every client test these cases, so their validation cannot drift.
 */
export interface AcceptedSourceUrlCase {
  readonly input: string;
  readonly source: SetSource;
  readonly url: string;
}

export const ACCEPTED_SOURCE_URL_CASES: readonly AcceptedSourceUrlCase[] = [
  {
    input: "http://youtu.be/abcdefghijk?t=30",
    source: "youtube",
    url: "https://www.youtube.com/watch?v=abcdefghijk",
  },
  {
    input: "https://www.youtube.com/watch?v=abcdefghijk&list=ignored",
    source: "youtube",
    url: "https://www.youtube.com/watch?v=abcdefghijk",
  },
  {
    input: "https://m.youtube.com/shorts/abcdefghijk/",
    source: "youtube",
    url: "https://www.youtube.com/watch?v=abcdefghijk",
  },
  {
    input: "https://music.youtube.com/live/abcdefghijk",
    source: "youtube",
    url: "https://www.youtube.com/watch?v=abcdefghijk",
  },
  {
    input: "https://youtube.com/embed/abcdefghijk/",
    source: "youtube",
    url: "https://www.youtube.com/watch?v=abcdefghijk",
  },
  {
    input: "http://m.soundcloud.com/artist/track/?ref=share",
    source: "soundcloud",
    url: "https://soundcloud.com/artist/track",
  },
  {
    input: "https://music.apple.com/us/album/example-dj-mix/1700000000",
    source: "apple-music",
    url: "https://music.apple.com/album/1700000000",
  },
  {
    input:
      "https://music.apple.com/gb/album/example-dj-mix/1700000000?i=1700000002",
    source: "apple-music",
    url: "https://music.apple.com/album/1700000000",
  },
  {
    input: "https://music.apple.com/album/1700000000/",
    source: "apple-music",
    url: "https://music.apple.com/album/1700000000",
  },
];

export const REJECTED_SOURCE_URLS: readonly string[] = [
  "not a URL",
  ["javascript", "alert(1)"].join(":"),
  "https://user:password@www.youtube.com/watch?v=abcdefghijk",
  "https://soundcloud.com:8080/artist/track",
  "https://youtube.com.evil.test/watch?v=abcdefghijk",
  "https://youtu.be/abcdefghijk/extra",
  "https://youtube.com/shorts/abcdefghij",
  "https://youtube.com/embed/abcdefghijk/extra",
  "https://soundcloud.com/artist/track/extra",
  "https://soundcloud.com/artist/sets",
  "https://soundcloud.com/artist/tracks",
  "https://soundcloud.com/artist/albums",
  "https://soundcloud.com/artist/likes",
  "https://soundcloud.com/artist/reposts",
  "https://music.apple.com/us/playlist/example/pl.0123456789abcdef",
  "https://music.apple.com/us/artist/example-dj/123456",
  "https://music.apple.com/us/song/example-song/1700000002",
  "https://music.apple.com/us/station/example-radio/ra.1460000000",
  "https://music.apple.com/us/album/example-dj-mix/not-an-id",
  "https://music.apple.com/us/album/example-dj-mix/1700000000/extra",
  "https://music.apple.com.evil.test/us/album/example/1700000000",
];
