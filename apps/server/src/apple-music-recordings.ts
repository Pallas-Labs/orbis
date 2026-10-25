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

interface ReplayedRecording {
  readonly body: { readonly data?: readonly { readonly id: string }[] };
  readonly status: number;
  readonly url: string;
}

/**
 * Apple Music as a lane or a browser journey sees it: the recorded answers, found by address. A
 * single album read is answered from any recorded album, so a journey can save whichever result
 * it chooses, and a search nobody recorded finds nothing. The key is made for this run, and
 * nothing reaches Apple.
 */
export const appleMusicReplay = async () => {
  const recordings = await appleMusicRecordings<ReplayedRecording>();
  const albums = new Map(
    [...recordings.values()].flatMap((recording) =>
      (recording.body.data ?? []).map((album) => [album.id, album] as const)
    )
  );
  const key = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"]
  );
  const answer = (url: string): Response => {
    const recording = recordings.get(url);
    if (recording) {
      return Response.json(recording.body, { status: recording.status });
    }
    if (new URL(url).pathname.endsWith("/search")) {
      return Response.json({ results: {} });
    }
    const albumId = /\/albums\/(?<id>\d+)\?include=tracks$/u.exec(url)?.groups
      ?.id;
    const album = albumId ? albums.get(albumId) : undefined;
    return album
      ? Response.json({ data: [album] })
      : Response.json({ errors: [] }, { status: 404 });
  };
  return {
    answer,
    credentials: {
      keyId: "LANEKEY",
      privateKey: musicKitPem(
        await crypto.subtle.exportKey("pkcs8", key.privateKey)
      ),
      teamId: "LANE",
    },
    /** Whether this address is Apple's, rather than another provider's. */
    isAppleMusic: (url: string) =>
      url.startsWith("https://api.music.apple.com/"),
  };
};
