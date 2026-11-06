import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Schema } from "effect";
import { Miniflare, Response as MiniflareResponse } from "miniflare";

import { appleMusicReplay } from "../../server/src/apple-music-recordings.js";
import { workerModules } from "./worker-modules.js";

// The Group's SQLite binds at most 100 values in one statement, and a Cue binds 7, so an album
// of more than 14 songs cannot store its Tracklist in one insert. Apple's first DJ mix for
// "Defected" has 17.
const SEARCH = "Defected";
const NOT_IN_US_CATALOG =
  "https://music.apple.com/jp/album/exit-trance-01-mixed-by-dj-uto/1016775152";

const artifact = path.resolve(
  import.meta.dir,
  "../../../.cache/api-apple-music",
  crypto.randomUUID()
);
await mkdir(artifact, { recursive: true });
const Search = Schema.Struct({
  albums: Schema.Array(
    Schema.Struct({
      djMix: Schema.Boolean,
      songCount: Schema.Number,
      title: Schema.String,
      url: Schema.String,
    })
  ),
});
const SavedSet = Schema.Struct({
  id: Schema.String,
  metadataState: Schema.String,
  source: Schema.String,
  title: Schema.String,
  tracklistState: Schema.String,
  url: Schema.String,
});
const Tracklist = Schema.Struct({
  cues: Schema.Array(Schema.Struct({ position: Schema.Number })),
});
const Refusal = Schema.Struct({ message: Schema.String });
const Library = Schema.Struct({
  sets: Schema.Array(Schema.Struct({ url: Schema.String })),
});

const appleMusic = await appleMusicReplay();
const asked: string[] = [];
const bundle = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "tracklist-worker.ts")],
  external: ["cloudflare:workers", "node:*"],
  target: "browser",
});
assert.equal(bundle.success, true, String(bundle.logs));
const [output] = bundle.outputs;
assert.ok(output !== undefined);
const runtime = new Miniflare({
  bindings: {
    APPLE_MUSIC_KEY_ID: appleMusic.credentials.keyId,
    APPLE_MUSIC_PRIVATE_KEY: appleMusic.credentials.privateKey,
    APPLE_MUSIC_TEAM_ID: appleMusic.credentials.teamId,
    AUDIO_NODE_URL: "https://audio.example",
    STREAM_GRANT_SECRET: "ef".repeat(32),
  },
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { GROUP: { className: "Group", useSQLite: true } },
  durableObjectsPersist: path.join(artifact, "storage"),
  modules: workerModules(await output.text()),
  // Apple answers with its recorded responses; nothing else is reachable.
  outboundService: async (request) => {
    asked.push(request.url);
    const answer = appleMusic.isAppleMusic(request.url)
      ? appleMusic.answer(request.url)
      : new Response("not found", { status: 404 });
    return new MiniflareResponse(await answer.text(), {
      headers: { "content-type": "application/json" },
      status: answer.status,
    });
  },
});
const call = async (
  route: string,
  method = "GET",
  payload?: { readonly url: string }
) => {
  const response = await runtime.dispatchFetch(`http://orbis/api${route}`, {
    body: payload && JSON.stringify(payload),
    headers: {
      "CF-Connecting-IP": "192.0.2.1",
      authorization: "Bearer listener-token",
      "content-type": "application/json",
    },
    method,
  });
  return { status: response.status, text: await response.text() };
};
try {
  const seeded = await call("/__seed-tracklist");
  assert.equal(seeded.status, 200, seeded.text);

  const search = await call(
    `/apple-music/search?${new URLSearchParams({ q: SEARCH })}`
  );
  assert.equal(search.status, 200, search.text);
  const [chosen] = Schema.decodeUnknownSync(Search)(
    JSON.parse(search.text)
  ).albums;
  assert.ok(chosen !== undefined, `"${SEARCH}" found no albums`);
  assert.ok(chosen.djMix, `${chosen.title} is not a DJ mix`);
  assert.ok(chosen.songCount > 14, `${chosen.title} fits in one insert`);

  const saved = await call("/sets", "POST", { url: chosen.url });
  assert.equal(saved.status, 201, `saving ${chosen.url}: ${saved.text}`);
  const set = Schema.decodeUnknownSync(SavedSet)(JSON.parse(saved.text));
  assert.equal(set.source, "apple-music");
  assert.equal(set.url, chosen.url);
  assert.equal(set.title, chosen.title);
  assert.equal(set.metadataState, "enriched");
  assert.equal(set.tracklistState, "ready");
  const tracklist = await call(`/sets/${set.id}/tracklist`);
  assert.equal(tracklist.status, 200, tracklist.text);
  const { cues } = Schema.decodeUnknownSync(Tracklist)(
    JSON.parse(tracklist.text)
  );
  assert.equal(cues.length, chosen.songCount);
  assert.deepEqual(
    cues.map((cue) => cue.position),
    cues.map((_, position) => position)
  );

  // A save the server can name is refused with its reason, and makes no Set.
  const refused = await call("/sets", "POST", { url: NOT_IN_US_CATALOG });
  assert.equal(refused.status, 400, refused.text);
  assert.equal(
    Schema.decodeUnknownSync(Refusal)(JSON.parse(refused.text)).message,
    "This album is not in the US Apple Music catalog."
  );
  const listed = await call("/sets");
  assert.equal(listed.status, 200, listed.text);
  const library = Schema.decodeUnknownSync(Library)(JSON.parse(listed.text));
  assert.deepEqual(
    library.sets
      .map((entry) => entry.url)
      .filter((url) => url.startsWith("https://music.apple.com/")),
    [chosen.url]
  );

  await writeFile(
    path.join(artifact, "result.json"),
    `${JSON.stringify(
      {
        appleAsked: asked,
        refused: { status: refused.status, url: NOT_IN_US_CATALOG },
        saved: {
          cues: cues.length,
          id: set.id,
          songCount: chosen.songCount,
          title: set.title,
          tracklistState: set.tracklistState,
          url: set.url,
        },
        search: SEARCH,
      },
      null,
      2
    )}\n`
  );
  console.log(
    `Apple Music save journey passed. ${path.join(artifact, "result.json")}`
  );
} finally {
  await runtime.dispose();
}
