/* oxlint-disable no-await-in-loop -- Apple answers 429 to a burst of reads, so they go one at a time. */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { Effect, Schema } from "effect";

import { appleMusicTokens } from "./apple-music-token.js";
import {
  appleMusicAlbumRead,
  appleMusicAlbumsRead,
  AppleMusicSearchResponse,
  appleMusicSearchReads,
  mergedAlbumIds,
} from "./metadata.js";

/**
 * The albums the Apple Music HTTP tests replay: Seth Troxler's DJ-Kicks (DJ Mix), and DJ UTO's
 * EXIT TRANCE #01, a mix in the Japanese catalog that the US catalog lacks.
 */
const DEFAULT_ALBUM_IDS = ["1046502556", "1016775152"];
/**
 * The searches the tests replay: a DJ, a mix series, a label, a studio artist, a DJ with studio
 * albums of his own, and a radio mix series.
 */
const DEFAULT_SEARCHES = [
  "Seth Troxler",
  "DJ-Kicks",
  "Defected",
  "Radiohead",
  "Carl Cox",
  "Essential Mix",
];
const FIXTURES = path.resolve(import.meta.dir, "fixtures/apple-music");
const decodeSearch = Schema.decodeUnknownSync(AppleMusicSearchResponse);

const slug = (words: string) =>
  words
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "");

/**
 * Records Apple's answers to the reads the Group makes, status and body as Apple answered, so the
 * tests replay them. The key stays in its file; only Apple's answers are written.
 *
 *   bun run record:apple-music [album id...]
 *   bun run record:apple-music --search [words...]
 *   bun run record:apple-music --albums
 *
 * `--albums` reads again only the albums of each search already recorded, so the albums gain the
 * fields a search now reads while the recorded searches, and the tests' expected results, stay.
 */
const main = async () => {
  const [first, ...rest] = process.argv.slice(2);
  const searching = first === "--search";
  const albumsOnly = first === "--albums";
  const keyId = process.env.APPLE_MUSIC_KEY_ID ?? "R94UBZ4H8M";
  const teamId = process.env.APPLE_MUSIC_TEAM_ID ?? "JR398S689Z";
  const keyPath =
    process.env.APPLE_MUSIC_KEY_PATH ??
    path.join(homedir(), ".config/orbis", `AuthKey_${keyId}.p8`);
  const privateKey = await readFile(keyPath, "utf-8").catch(() => null);
  if (privateKey === null) {
    console.error(`No MusicKit key at ${keyPath}.`);
    return 1;
  }
  const token = await Effect.runPromise(
    appleMusicTokens({ keyId, privateKey, teamId })()
  );
  await mkdir(FIXTURES, { recursive: true });

  /** Writes one recording and returns Apple's body as text, or null when Apple refused. */
  const record = async (url: string, name: string): Promise<string | null> => {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status !== 200 && response.status !== 404) {
      console.error(`Apple Music answered ${response.status} for ${url}.`);
      return null;
    }
    const text = await response.text();
    const recording = {
      body: JSON.parse(text),
      recordedAt: new Date().toISOString(),
      status: response.status,
      url,
    };
    const file = path.join(FIXTURES, `${name}.json`);
    await writeFile(file, `${JSON.stringify(recording, null, 2)}\n`);
    console.log(`${response.status} ${url} -> ${path.relative(".", file)}`);
    return text;
  };

  if (albumsOnly) {
    const recorded = await readdir(FIXTURES);
    for (const albumsName of recorded.filter((name) =>
      name.endsWith("-albums.json")
    )) {
      const name = albumsName.replace(/-albums\.json$/u, "");
      // oxlint-disable-next-line orbis/bounded-concurrency -- reads the two recorded files of one album.
      const found = await Promise.all(
        [`${name}.json`, `${name}-dj-mix.json`].map(async (file) =>
          decodeSearch(
            JSON.parse(await readFile(path.join(FIXTURES, file), "utf-8")).body
          )
        )
      );
      if (
        (await record(
          appleMusicAlbumsRead(mergedAlbumIds(found)),
          `${name}-albums`
        )) === null
      ) {
        return 1;
      }
    }
    return 0;
  }

  if (!searching) {
    const albumIds = first ? [first, ...rest] : DEFAULT_ALBUM_IDS;
    let failed = false;
    for (const albumId of albumIds) {
      if ((await record(appleMusicAlbumRead(albumId), albumId)) === null) {
        failed = true;
      }
    }
    return failed ? 1 : 0;
  }

  const searches = rest.length > 0 ? rest : DEFAULT_SEARCHES;
  for (const words of searches) {
    const name = `search-${slug(words)}`;
    const found = [];
    for (const [index, url] of appleMusicSearchReads(words).entries()) {
      const body = await record(url, index === 0 ? name : `${name}-dj-mix`);
      if (body === null) {
        return 1;
      }
      found.push(decodeSearch(JSON.parse(body)));
    }
    const ids = mergedAlbumIds(found);
    if (
      ids.length > 0 &&
      (await record(appleMusicAlbumsRead(ids), `${name}-albums`)) === null
    ) {
      return 1;
    }
  }
  return 0;
};

if (import.meta.main) {
  process.exitCode = await main();
}
