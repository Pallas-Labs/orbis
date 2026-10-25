import { readdir, readFile } from "node:fs/promises";

/** Where `bun run record:apple-music` keeps Apple's answers. */
const RECORDINGS = new URL("fixtures/apple-music/", import.meta.url);

/** Every recorded Apple Music answer, by the address it answers. */
export const appleMusicRecordings = async <
  Recording extends { readonly url: string },
>(): Promise<Map<string, Recording>> => {
  const names = await readdir(RECORDINGS);
  const recordings: Recording[] = await Promise.all(
    names.map(async (name) =>
      JSON.parse(await readFile(new URL(name, RECORDINGS), "utf-8"))
    )
  );
  return new Map(recordings.map((recording) => [recording.url, recording]));
};

/** A private key made for one run, in the PEM armor a MusicKit `.p8` file has. */
export const musicKitPem = (der: ArrayBuffer) =>
  `-----BEGIN PRIVATE KEY-----\n${btoa(
    String.fromCodePoint(...new Uint8Array(der))
  )}\n-----END PRIVATE KEY-----\n`;
