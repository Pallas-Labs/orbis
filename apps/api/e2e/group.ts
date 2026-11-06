import { Database as BunDatabase } from "bun:sqlite";

import "../../server/src/trust-storage-bun.js";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect, Layer } from "effect";
import { HttpServerResponse } from "effect/http";
import { Miniflare } from "miniflare";

import { createPortableApp } from "../../server/src/app-core.js";
import { releaseAudio } from "../../server/src/audio-release.js";
import { layer } from "../../server/src/db/database.js";
import { hashToken } from "../../server/src/identity.js";
import { pollUntil, runInOrder } from "../../server/src/test-http.js";
import { audioLayer } from "../src/audio.js";
import { workerModules } from "./worker-modules.js";

const artifact = path.resolve(
  import.meta.dir,
  "../../../.cache/api-group",
  crypto.randomUUID()
);
await mkdir(artifact, { recursive: true });
const bundle = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "worker.ts")],
  external: ["cloudflare:workers", "node:*"],
  target: "browser",
});
assert.equal(bundle.success, true, String(bundle.logs));
const [output] = bundle.outputs;
assert.ok(output);
const script = await output.text();
const production = await readFile(
  path.join(import.meta.dir, "../dist/index.js"),
  "utf-8"
);
assert.doesNotMatch(production, /bun:sqlite|node:fs|Bun\.|yt-dlp|cobalt/u);
const options = {
  bindings: {
    AUDIO_NODE_URL: "https://audio.example",
    STREAM_GRANT_SECRET: "ab".repeat(32),
  },
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { GROUP: { className: "Group", useSQLite: true } },
  durableObjectsPersist: path.join(artifact, "storage"),
  modules: workerModules(script),
};
/**
 * An Orbis Link's three routes answer without a key under workerd, with absolute `/api`
 * image and `/s/<id>` addresses, and the image is a 1200x630 PNG drawn from local Artwork.
 * The Worker's cache answers repeat image requests, so each image version reaches the Group
 * once, and a key-gated route never enters that cache.
 */
const checkShareRoutes = async (
  miniflare: Miniflare,
  id: string,
  keyed: (route: string) => Promise<Response>
) => {
  const artwork = await Bun.file(
    path.join(import.meta.dir, "../../server/src/fixtures/share-artwork.jpg")
  ).bytes();
  const host = Bun.serve({
    fetch: () =>
      new Response(artwork, { headers: { "content-type": "image/jpeg" } }),
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const seeded = await miniflare.dispatchFetch(
      `http://orbis/api/__share?${new URLSearchParams({
        artwork: `${host.url.origin}/maxresdefault.jpg`,
        creator: "Boiler Room",
        title: "Peggy Gou | Boiler Room Seoul",
      })}`
    );
    assert.equal(seeded.status, 200);
    const json = await miniflare.dispatchFetch(
      `http://orbis/api/share/sets/${id}`
    );
    assert.equal(json.status, 200, await json.clone().text());
    const shared = await json.json();
    assert.equal(shared.title, "Peggy Gou | Boiler Room Seoul");
    const pageResponse = await miniflare.dispatchFetch(
      `http://orbis/api/share/sets/${id}/page`
    );
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.text();
    // Miniflare hands the Worker its loopback origin; production hands it orbis.p11a.xyz.
    const origin =
      /<meta property="og:url" content="(?<origin>https?:\/\/[^/"]+)\/s\//u.exec(
        page
      )?.groups?.origin;
    assert.ok(origin);
    assert.ok(
      page.includes(`<meta property="og:url" content="${origin}/s/${id}">`)
    );
    const imageOf = (html: string) => {
      const image =
        /<meta property="og:image" content="(?<image>[^"]+)">/u.exec(html)
          ?.groups?.image;
      assert.ok(image);
      assert.match(
        image,
        new RegExp(
          `^${origin}/api/share/sets/${id}/image\\.png\\?v=[0-9a-f]{16}$`,
          "u"
        )
      );
      return image.slice(origin.length);
    };
    const imagePath = imageOf(page);
    assert.doesNotMatch(page, /Group smoke/u);
    const caches = await miniflare.getCaches();
    const cache = caches.default;
    const cacheKey = (route: string) =>
      `https://${new URL(origin).host}${route}`;
    const arrivals = async () => {
      const response = await miniflare.dispatchFetch(
        "http://orbis/api/__share-image-arrivals"
      );
      return Number(await response.text());
    };
    /** Waits for the Worker's `waitUntil` to store the image, which ends after the response. */
    const stored = async (route: string) => {
      const hit = await pollUntil(() => cache.match(cacheKey(route)), {
        attempts: 100,
        interval: 50,
        message: `${route} never entered the Worker's cache`,
      });
      await hit.arrayBuffer();
    };
    const fetchImage = async (route: string) => {
      const image = await miniflare.dispatchFetch(`http://orbis${route}`, {
        redirect: "manual",
      });
      assert.equal(image.status, 200, route);
      assert.equal(image.headers.get("content-type"), "image/png");
      assert.equal(
        image.headers.get("cache-control"),
        "public, max-age=31536000, immutable"
      );
      return Buffer.from(await image.arrayBuffer());
    };

    const before = await arrivals();
    const png = await fetchImage(imagePath);
    await stored(imagePath);
    const repeats = [
      imagePath,
      `${imagePath}&x=1`,
      imagePath.replace("/share/sets/", "/share//sets/").replace("?", "?x=2&"),
    ];
    await runInOrder(repeats, async (route) => {
      const repeat = await fetchImage(route);
      assert.ok(repeat.equals(png), route);
    });
    const afterRepeats = await arrivals();
    const repeatArrivals = afterRepeats - before;
    assert.equal(repeatArrivals, 1);

    const unversioned = await miniflare.dispatchFetch(
      `http://orbis/api/share/sets/${id}/image.png`,
      { redirect: "manual" }
    );
    assert.equal(unversioned.status, 302);
    assert.equal(unversioned.headers.get("location"), `${origin}${imagePath}`);
    assert.equal(unversioned.headers.get("cache-control"), "no-store");
    await unversioned.arrayBuffer();

    const retitled = await miniflare.dispatchFetch(
      `http://orbis/api/__share?${new URLSearchParams({
        artwork: `${host.url.origin}/maxresdefault.jpg`,
        creator: "Boiler Room",
        title: "Peggy Gou | Boiler Room Seoul (Extended)",
      })}`
    );
    assert.equal(retitled.status, 200);
    const newPageResponse = await miniflare.dispatchFetch(
      `http://orbis/api/share/sets/${id}/page`
    );
    const newPage = await newPageResponse.text();
    const newImagePath = imageOf(newPage);
    assert.notEqual(newImagePath, imagePath);
    const beforeRetitle = await arrivals();
    const newPng = await fetchImage(newImagePath);
    assert.ok(!newPng.equals(png));
    await stored(newImagePath);
    const newRepeat = await fetchImage(newImagePath);
    assert.ok(newRepeat.equals(newPng));
    const afterRetitle = await arrivals();
    const retitleArrivals = afterRetitle - beforeRetitle;
    assert.equal(retitleArrivals, 1);

    const me = await keyed("/me?v=1");
    assert.equal(me.status, 200);
    await me.arrayBuffer();
    await runInOrder(
      [
        "/api/me?v=1",
        `/api/share/sets/${id}/image.png`,
        `/api/share/sets/${id}/image.png?v=0000000000000000`,
      ],
      async (route) => {
        assert.equal(await cache.match(cacheKey(route)), undefined, route);
      }
    );

    const header = new DataView(png.buffer, png.byteOffset, png.byteLength);
    assert.equal(new TextDecoder().decode(png.subarray(12, 16)), "IHDR");
    assert.deepEqual([header.getUint32(16), header.getUint32(20)], [1200, 630]);
    await writeFile(path.join(artifact, "share-image.png"), png);
    await writeFile(path.join(artifact, "share-image-retitled.png"), newPng);
    await writeFile(path.join(artifact, "share-page.html"), page);
    const unknown = await miniflare.dispatchFetch(
      `http://orbis/api/share/sets/${crypto.randomUUID()}/image.png`
    );
    assert.equal(unknown.status, 404);
    return {
      imageArrivals: { repeated: repeatArrivals, retitled: retitleArrivals },
      page: true,
      png: png.length,
    };
  } finally {
    await host.stop(true);
  }
};
let runtime = new Miniflare(options);
try {
  const health = await runtime.dispatchFetch("http://orbis/api/health");
  assert.equal(health.status, 200, await health.clone().text());
  assert.deepEqual(await health.json(), { status: "ok" });
  assert.ok(health.headers.get("x-smoke-group"));
  const second = await runtime.dispatchFetch("http://other/api/health");
  assert.equal(
    health.headers.get("x-smoke-group"),
    second.headers.get("x-smoke-group")
  );
  const unavailable = await runtime.dispatchFetch("http://orbis/api/sets");
  assert.equal(unavailable.status, 403);
  const schemaResponse = await runtime.dispatchFetch(
    "http://orbis/api/__schema"
  );
  const schema = await schemaResponse.json();
  const seeded = await runtime.dispatchFetch("http://orbis/api/__seed");
  assert.equal(seeded.status, 200);
  const call = (
    route: string,
    method = "GET",
    body?: Record<string, string | string[]>,
    token = "smoke-token"
  ) =>
    runtime.dispatchFetch(`http://orbis/api${route}`, {
      body: JSON.stringify(body),
      headers: {
        "CF-Connecting-IP": "192.0.2.1",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method,
      signal: AbortSignal.timeout(90_000),
    });
  const me = await call("/me");
  assert.equal(me.status, 200, await me.clone().text());
  const savedResponse = await call("/sets", "POST", {
    tags: [],
    title: "Group smoke",
    url: "https://youtu.be/abcdefghijk",
  });
  assert.equal(savedResponse.status, 201, await savedResponse.clone().text());
  const saved = await savedResponse.json();
  assert.ok(saved.id);
  const share = await checkShareRoutes(runtime, saved.id, (route) =>
    call(route)
  );
  const playlistResponse = await call("/playlists", "POST", {
    name: "Group smoke playlist",
  });
  assert.equal(
    playlistResponse.status,
    201,
    await playlistResponse.clone().text()
  );
  const playlist = await playlistResponse.json();
  const edited = await call(`/playlists/${playlist.id}/sets`, "PUT", {
    setIds: [saved.id],
  });
  assert.equal(edited.status, 200, await edited.clone().text());
  const renamed = await call(`/playlists/${playlist.id}`, "PATCH", {
    name: "Edited in Group",
  });
  assert.equal(renamed.status, 200, await renamed.clone().text());
  const keyResponse = await call("/admin/people/host/keys", "POST", {
    label: "event reader",
  });
  assert.equal(keyResponse.status, 201, await keyResponse.clone().text());
  const eventKey = await keyResponse.json();
  const events = await call("/events", "GET", undefined, eventKey.token);
  assert.equal(events.status, 200);
  assert.ok(events.body);
  const reader = events.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /queue/u);
  const heartbeatDeadline = Date.now() + 40_000;
  let heartbeatSeen = false;
  while (Date.now() < heartbeatDeadline) {
    // eslint-disable-next-line no-await-in-loop -- A stream must be consumed in order.
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    if (new TextDecoder().decode(chunk.value).includes('"heartbeat"')) {
      heartbeatSeen = true;
      break;
    }
  }
  assert.equal(heartbeatSeen, true);
  const revoked = await call(`/admin/keys/${eventKey.id}`, "DELETE");
  assert.equal(revoked.status, 200, await revoked.clone().text());
  let ended = false;
  const revocationDeadline = Date.now() + 35_000;
  while (Date.now() < revocationDeadline) {
    // eslint-disable-next-line no-await-in-loop -- stream chunks must be read in order
    const chunk = await reader.read();
    if (chunk.done) {
      ended = true;
      break;
    }
  }
  assert.equal(ended, true);
  const revokedSignIn = await call("/me", "GET", undefined, eventKey.token);
  assert.equal(revokedSignIn.status, 401);
  await Promise.all(
    Array.from({ length: 21 }, () => call("/me", "GET", undefined, "bad-key"))
  );
  const limited = await call("/me", "GET", undefined, "bad-key");
  assert.equal(limited.status, 429);
  const differentAddress = await runtime.dispatchFetch("http://orbis/api/me", {
    headers: {
      "CF-Connecting-IP": "192.0.2.2",
      authorization: "Bearer bad-key",
    },
  });
  assert.equal(differentAddress.status, 401);
  const jobs = await runtime.dispatchFetch("http://orbis/api/__jobs");
  assert.deepEqual(await jobs.json(), [{ state: "queued" }]);
  const databasePath = path.join(artifact, "bun.sqlite");
  await Effect.runPromise(
    Effect.scoped(
      Layer.build(
        layer({
          databasePath,
          migrationsFolder: path.resolve(
            import.meta.dir,
            "../../server/drizzle"
          ),
        })
      )
    )
  );
  const db = new BunDatabase(databasePath);
  const bunSchema = db
    .query(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    )
    .all();
  db.close();
  assert.deepEqual(schema, bunSchema);
  const bunToken = "bun-parity-host-key";
  const trustPath = path.join(artifact, "bun-devices.json");
  await writeFile(
    trustPath,
    JSON.stringify({
      keys: [
        {
          addedAt: "2026-01-01T00:00:00.000Z",
          id: "bun-parity-key",
          label: "Bun parity",
          lastUsedAt: null,
          personId: "host",
          scope: "daily",
          tokenHash: hashToken(bunToken),
        },
      ],
      people: [{ id: "host", removed: false, username: "host" }],
      version: 2,
    })
  );
  const app = createPortableApp({
    audio: audioLayer,
    audioResponse: () => HttpServerResponse.empty({ status: 404 }),
    database: layer({
      databasePath,
      migrationsFolder: path.resolve(import.meta.dir, "../../server/drizzle"),
    }),
    logging: { pretty: false, silent: true },
    releaseAudio,
    streamSecret: Buffer.from("ab".repeat(32), "hex"),
    trustPath,
  });
  try {
    const bunSaved = await app.handler(
      new Request("http://localhost/sets", {
        body: JSON.stringify({
          tags: [],
          title: "Injected database",
          url: "https://youtu.be/abcdefghijk",
        }),
        headers: {
          authorization: `Bearer ${bunToken}`,
          "content-type": "application/json",
        },
        method: "POST",
      })
    );
    assert.equal(bunSaved.status, 201, await bunSaved.clone().text());
    const injected = new BunDatabase(databasePath, { readonly: true });
    assert.deepEqual(
      injected.query("SELECT title_override FROM library_entries").all(),
      [{ title_override: "Injected database" }]
    );
    injected.close();
  } finally {
    await app.dispose();
  }
  const approvalCall = (
    route: string,
    body: Record<string, string>,
    client: string,
    token?: string
  ) => {
    const headers = new Headers({
      "CF-Connecting-IP": client,
      "content-type": "application/json",
    });
    if (token) {
      headers.set("authorization", `Bearer ${token}`);
    }
    return runtime.dispatchFetch(`http://orbis/api${route}`, {
      body: JSON.stringify(body),
      headers,
      method: "POST",
      signal: AbortSignal.timeout(90_000),
    });
  };
  const tvAddress = "192.0.2.20";
  const phoneAddress = "192.0.2.21";
  const startApproval = async () => {
    const response = await approvalCall(
      "/sign-in/requests",
      { label: "Group journey TV", platform: "tvOS" },
      tvAddress
    );
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal(response.headers.get("cache-control"), "no-store");
    const started = await response.json();
    assert.match(started.code, /^\d{6}$/u);
    return started;
  };
  const waitApproval = (secret: string) =>
    approvalCall("/sign-in/requests/wait", { secret }, tvAddress);
  const approvalRequest = await startApproval();
  const waitStarted = performance.now();
  const pendingWait = await waitApproval(approvalRequest.secret);
  const approvalRequestPendingAfterMs = Math.round(
    performance.now() - waitStarted
  );
  assert.equal(pendingWait.status, 200, await pendingWait.clone().text());
  assert.deepEqual(await pendingWait.json(), { status: "pending" });
  assert.ok(
    approvalRequestPendingAfterMs >= 24_500 &&
      approvalRequestPendingAfterMs <= 27_000,
    `pending after ${approvalRequestPendingAfterMs} ms`
  );
  let openWaitSettled = false;
  const openWait = (async () => {
    const response = await waitApproval(approvalRequest.secret);
    openWaitSettled = true;
    return response;
  })();
  const found = await approvalCall(
    "/me/sign-in-requests/find",
    { code: approvalRequest.code },
    phoneAddress,
    "smoke-token"
  );
  assert.equal(found.status, 200, await found.clone().text());
  const foundRequest = await found.json();
  assert.equal(foundRequest.label, "Group journey TV");
  assert.equal(openWaitSettled, false, "the wait is open during approval");
  const approvedAt = performance.now();
  const approval = await approvalCall(
    "/me/sign-in-requests/approve",
    { code: approvalRequest.code },
    phoneAddress,
    "smoke-token"
  );
  assert.equal(approval.status, 200, await approval.clone().text());
  const collected = await openWait;
  const approvalApprovedWithinMs = Math.round(performance.now() - approvedAt);
  assert.equal(collected.status, 200, await collected.clone().text());
  assert.ok(
    approvalApprovedWithinMs < 1000,
    `approved after ${approvalApprovedWithinMs} ms`
  );
  const approved = await collected.json();
  assert.equal(approved.status, "approved");
  assert.deepEqual(approved.person, { id: "host", username: "host" });
  const tvMe = await call("/me", "GET", undefined, approved.key);
  assert.equal(tvMe.status, 200, await tvMe.clone().text());
  const tvPerson = await tvMe.json();
  assert.equal(tvPerson.id, "host");
  const droppedRequest = await startApproval();
  const written = await runtime.dispatchFetch("http://orbis/api/__write");
  assert.equal(written.status, 200);
  await runtime.dispose();
  runtime = new Miniflare(options);
  const restored = await runtime.dispatchFetch("http://orbis/api/__read");
  assert.deepEqual(await restored.json(), [{ value: "persisted" }]);
  const restoredSignIn = await call("/me");
  assert.equal(restoredSignIn.status, 200);
  const persistedSets = await call("/sets");
  assert.equal(persistedSets.status, 200, await persistedSets.clone().text());
  const restoredLibrary = await persistedSets.json();
  assert.equal(restoredLibrary.sets[0].id, saved.id);
  const dropped = await waitApproval(droppedRequest.secret);
  assert.equal(dropped.status, 404, await dropped.clone().text());
  await writeFile(
    path.join(artifact, "result.json"),
    `${JSON.stringify(
      {
        approvalApprovedWithinMs,
        approvalDroppedOnRestart: true,
        approvalRequestPendingAfterMs,
        authenticatedApi: true,
        downloadsQueued: true,
        editedPlaylist: playlist.id,
        events: true,
        health: "ok",
        heartbeat: true,
        injectedDatabaseUsed: true,
        persistsAcrossRestart: true,
        rateLimitByClientAddress: true,
        revokedStreamClosed: true,
        savedSet: saved.id,
        schema,
        schemaMatchesBun: true,
        share,
        singleton: true,
      },
      null,
      2
    )}\n`
  );
  console.log(`Group smoke passed. ${path.join(artifact, "result.json")}`);
} finally {
  await runtime.dispose();
}
