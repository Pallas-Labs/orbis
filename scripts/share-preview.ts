/**
 * Renders an Orbis Link for a fixture Set through the real HTTP handler and keeps the
 * results: the preview PNG, the page HTML, and the image route's render times.
 *
 *   bun scripts/share-preview.ts --out <directory> [--serve]
 *
 * With `--serve` it keeps answering on loopback and prints a ready record with the address
 * and the Set id, so the routes can be read with curl. Artwork comes from a local host.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { Effect, Schema } from "effect";

import { createApp } from "../apps/server/src/app.js";
import { hashToken } from "../apps/server/src/identity.js";
import type { LoggedRecord } from "../apps/server/src/logging.js";
import { Metadata } from "../apps/server/src/metadata.js";
import { runTimesInOrder } from "../apps/server/src/test-http.js";

const { values } = parseArgs({
  options: { out: { type: "string" }, serve: { type: "boolean" } },
});
if (values.out === undefined || values.out === "") {
  throw new Error("Pass --out <directory>.");
}
const out = path.resolve(values.out);
await mkdir(out, { recursive: true });

const artwork = await Bun.file(
  path.join(import.meta.dir, "../apps/server/src/fixtures/share-artwork.jpg")
).bytes();
const artworkHost = Bun.serve({
  fetch: () =>
    new Response(artwork, { headers: { "content-type": "image/jpeg" } }),
  hostname: "127.0.0.1",
  port: 0,
});

const directory = await mkdtemp(path.join(tmpdir(), "orbis-share-preview-"));
const token = "share-preview-key";
const devicesPath = path.join(directory, "devices.json");
await writeFile(
  devicesPath,
  JSON.stringify({
    keys: [
      {
        addedAt: new Date().toISOString(),
        id: "preview-key",
        label: "Preview",
        lastUsedAt: null,
        personId: "host",
        scope: "daily",
        tokenHash: hashToken(token),
      },
    ],
    people: [{ id: "host", removed: false, username: "host" }],
    version: 2,
  })
);
const timings: LoggedRecord[] = [];
const app = createApp({
  databasePath: path.join(directory, "library.sqlite"),
  devicesPath,
  logging: {
    onEvent: (event) => {
      if (event.share !== undefined) {
        timings.push(event.share);
      }
    },
    silent: true,
  },
  metadata: Metadata.layerOf({
    enrich: () =>
      Effect.succeed({
        artworkLargeUrl: `${artworkHost.url.origin}/vi/fredAgainBR/maxresdefault.jpg`,
        artworkUrl: `${artworkHost.url.origin}/vi/fredAgainBR/mqdefault.jpg`,
        creator: "Boiler Room",
        durationSeconds: 5520,
        releasedAt: "2026-02-14T20:00:00.000Z",
        title: "Fred again.. | Boiler Room London, Live from Printworks",
      }),
  }),
});
const server = Bun.serve({
  fetch: async (request) => await app.handler(request, "device", "127.0.0.1"),
  hostname: "127.0.0.1",
  port: 0,
});
const base = server.url.origin;
const saved = await fetch(`${base}/sets`, {
  body: JSON.stringify({ url: "https://www.youtube.com/watch?v=fredAgainBR" }),
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  },
  method: "POST",
  signal: AbortSignal.timeout(30_000),
});
if (saved.status !== 201) {
  throw new Error(`Saving the fixture Set failed: ${await saved.text()}`);
}
const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
  await saved.json()
);
const page = await fetch(`${base}/share/sets/${id}/page`, {
  signal: AbortSignal.timeout(30_000),
});
await writeFile(path.join(out, "share-page.html"), await page.text());
let png = new Uint8Array();
await runTimesInOrder(10, async () => {
  const image = await fetch(`${base}/share/sets/${id}/image.png`, {
    signal: AbortSignal.timeout(30_000),
  });
  png = await image.bytes();
});
await writeFile(path.join(out, "share-image.png"), png);
await writeFile(
  path.join(out, "bun-timings.json"),
  `${JSON.stringify(timings, null, 2)}\n`
);
console.log(JSON.stringify({ address: base, id, out, ready: true }));
if (values.serve !== true) {
  await server.stop(true);
  await artworkHost.stop(true);
  await app.dispose();
}
