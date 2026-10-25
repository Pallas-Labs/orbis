import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import { appleMusicTokens } from "./apple-music-token.js";
import { appleMusicAlbumRead } from "./metadata.js";

/**
 * The albums the Apple Music HTTP tests replay: Seth Troxler's DJ-Kicks (DJ Mix), and DJ UTO's
 * EXIT TRANCE #01, a mix in the Japanese catalog that the US catalog lacks.
 */
const DEFAULT_ALBUM_IDS = ["1046502556", "1016775152"];
const FIXTURES = path.resolve(import.meta.dir, "fixtures/apple-music");

/**
 * Records each album read the Group makes, status and body as Apple answered, so the tests
 * replay Apple's real answers. The key stays in its file; only Apple's answers are written.
 */
const main = async () => {
  const albumIds =
    process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_ALBUM_IDS;
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
  const recorded = await Promise.all(
    albumIds.map(async (albumId) => {
      const url = appleMusicAlbumRead(albumId);
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.status !== 200 && response.status !== 404) {
        console.error(`Apple Music answered ${response.status} for ${url}.`);
        return false;
      }
      const recording = {
        body: await response.json(),
        recordedAt: new Date().toISOString(),
        status: response.status,
        url,
      };
      const file = path.join(FIXTURES, `${albumId}.json`);
      await writeFile(file, `${JSON.stringify(recording, null, 2)}\n`);
      console.log(`${response.status} ${url} -> ${path.relative(".", file)}`);
      return true;
    })
  );
  return recorded.every(Boolean) ? 0 : 1;
};

if (import.meta.main) {
  process.exitCode = await main();
}
