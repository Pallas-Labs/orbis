// A real Orbis API for the browser journeys: the server's own createApp and
// listeners, with two changes: Cobalt, the only third party a Download needs,
// answers with the repository's audio fixture, and Apple Music answers with its
// recorded responses. Everything else is the real code.
import path from "node:path";

import { createApp } from "../../server/src/app.ts";
import { appleMusicReplay } from "../../server/src/apple-music-recordings.ts";
import { startFixtureServer } from "../../server/src/fixture-server.ts";
import { Metadata } from "../../server/src/metadata.ts";

const root = path.resolve(import.meta.dir, "../../..");
const dataDirectory = process.env.ORBIS_DATA_DIR ?? "";
if (dataDirectory === "") {
  throw new Error("ORBIS_DATA_DIR is required.");
}
const fixture = Bun.file(path.join(root, "scripts/fixtures/ready-set.m4a"));
const cobaltUrl = "http://cobalt.journey.test/";
const tunnelUrl = "http://cdn.journey.test/ready-set.m4a";
const appleMusic = await appleMusicReplay();

const app = createApp({
  audio: {
    audioDir: path.join(dataDirectory, "audio"),
    cobaltApiKey: "journey",
    cobaltUrl,
    fetch: async (url) =>
      url.startsWith(cobaltUrl)
        ? Response.json({ status: "tunnel", url: tunnelUrl })
        : new Response(await fixture.arrayBuffer(), {
            headers: { "content-type": "audio/mp4" },
          }),
    startWorker: true,
  },
  databasePath: path.join(dataDirectory, "library.sqlite"),
  logging: { silent: true },
  // Only Apple Music answers; every other provider read misses, as offline.
  metadata: Metadata.layer({
    appleMusic: appleMusic.credentials,
    fetch: (url) =>
      Promise.resolve(
        appleMusic.isAppleMusic(url)
          ? appleMusic.answer(url)
          : new Response("not found", { status: 404 })
      ),
  }),
});
await startFixtureServer({
  allowedOrigin: process.env.ORBIS_FIXTURE_ORIGIN,
  app,
  port: Number(process.env.ORBIS_FIXTURE_PORT),
  token: "seeded-browser-fixture",
});
