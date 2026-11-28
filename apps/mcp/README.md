# Orbis Code Mode

`@orbis/mcp` is an MCP server on stdio with two tools, `search` and `execute`. An agent finds functions with `search`, then runs one JavaScript program with `execute` that reads and curates the caller's own Orbis library. It copies the shape of the factory's `factory mcp` (PAL-3046) and runs programs on [psychoscript](https://github.com/anomalyco/psychoscript)'s confined VM.

## Run

```sh
ORBIS_URL=https://orbis.example.test ORBIS_DEVICE_TOKEN=<device key> bun apps/mcp/src/main.ts
```

`ORBIS_URL` is the Orbis API, and `ORBIS_DEVICE_TOKEN` is a device key of the Person whose library the programs read. The server sends the key only in the `authorization` header. It never logs it, and an error message names only the function, the status and the service's own message. Stdout carries the protocol, so logs and a startup error go to stderr.

## Programs

A program is an async function body: it can `await` and `return`. It reaches Orbis only through these namespaces. It has no file system, network, process or timers. A run stops after `timeoutMs` (default 15000, at most 60000), and its result and logs are cut at 64 KB.

| Namespace | Functions |
| --- | --- |
| `sets` | `list`, `read`, `tracklist`, `audioState` |
| `playlists` | `list`, `shared`, `read` |
| `library` | `tags`, `heavyRotation`, `collections`, `collectionSets` |
| `queue` | `read` |
| `people` | `me`, `list`, `sets`, `playlists`, `listens` |
| `curate` | `setTags`, `setPlaylists`, `createPlaylist`, `renamePlaylist`, `setPlaylistSets`, `createCollection`, `updateCollection` |

Each function calls one `OrbisApi` endpoint with the device key, so the service applies the same rules as it does for the web and Raycast clients. `search` returns each function's TypeScript declaration, made from its `@orbis/contracts` Schemas.

```js
const { sets } = await sets.list({ tag: ["techno"] });
const stuck = [];
for (const set of sets) {
  const { state } = await sets.audioState({ id: set.id });
  if (state === "failed") stuck.push(set.title);
}
return stuck;
```

A call to a name that is not in the catalog fails with the nearest names, such as `sets.lsit is not a function (did you mean sets.list)`.

## What `curate` leaves out

Each `curate` write can be undone by another `curate` write. The catalog has no delete of any kind, no download cancel, no queue change, and nothing from the admin, sign-in, device-key or presence endpoints. It cannot change whether a Playlist is collaborative or who edits it. `curate.setPlaylistSets` refuses a Playlist the caller did not create, although the service lets an editor change it.

Playback diagnostics go only to SigNoz, and the API has no read for them. A playback check reads audio state, resume positions, the queue and Listens.

## Tests

`apps/server/src/codemode-http.test.ts` runs the engine against `createApp` with a real database and a real device key, and prints each step into an inline snapshot. It also checks that the catalog and `search` offer no forbidden function, and that the MCP server lists only `search` and `execute`.

```sh
bun run --filter @orbis/server test -- src/codemode-http.test.ts
```
