// The Orbis Code Mode catalog (PAL-3053): every function a program may call. A capability names its
// namespace, describes itself, decodes its input and encodes its output with Schemas from
// `@orbis/contracts`, and calls one `OrbisApi` endpoint through `OrbisClient`.
//
// What it leaves out is the point: no delete of any kind, no download cancel, no change to who may
// edit a Playlist, no write to a Playlist the caller does not own, no queue change, and nothing from
// the admin, sign-in, key or presence groups. Each write here can be undone by another write here.
import {
  AudioStateSchema,
  CollectionPayload,
  CollectionSchema,
  FriendListensSchema,
  FriendPlaylistSchema,
  LibraryResponseSchema,
  ListeningQueueSchema,
  ListeningRangeSchema,
  MAX_FRIEND_LISTENS,
  MeSchema,
  PlaylistDetailSchema,
  PlaylistMembersPayload,
  PlaylistNamePayload,
  PlaylistSchema,
  SavedSetSchema,
  SetPageSchema,
  SetPlaylistsPayload,
  SharedPlaylistSchema,
  TagsPayload,
  TracklistSchema,
} from "@orbis/contracts/http-api";
import { Effect, flow, Schema } from "effect";
import { HttpClientError } from "effect/http";
import { Host } from "psychoscript/effect";

import { OrbisClient } from "./client.js";
import type { OrbisApiClient } from "./client.js";

export type HostFailure = ReturnType<typeof Host.fail>;

/** One function of the catalog, as the engine and `search` see it. */
export interface Capability {
  readonly namespace: Namespace;
  readonly name: string;
  /** `namespace.name`, as a program calls it. */
  readonly path: string;
  readonly description: string;
  readonly input: Schema.Top;
  readonly output: Schema.Top;
  /** Decodes the program's input, calls Orbis, and encodes the answer as JSON. */
  readonly call: (
    input: Schema.Json | undefined
  ) => Effect.Effect<Schema.Json, HostFailure, OrbisClient>;
}

/** What each namespace is for, for `search` and the declarations. */
export const namespaces = {
  curate:
    "Reversible changes to the caller's own Sets, Playlists and Collections.",
  library:
    "Tags, Heavy Rotation and Collections (saved filters over Listening Time).",
  people:
    "The caller and the People they can see, with their Sets, Playlists and Listens.",
  playlists: "The caller's Playlists and the Playlists shared with them.",
  queue: "The caller's Listening Queue.",
  sets: "The caller's Sets: the library, one Set, its tracklist and its audio state.",
} as const;
export type Namespace = keyof typeof namespaces;

/** What one client call can fail with: the service's refusal, the transport, or the answer's shape. */
type CallError =
  | HostFailure
  | HttpClientError.HttpClientError
  | Schema.SchemaError
  | { readonly message: string };

const isHostFailure = (error: CallError): error is HostFailure =>
  error instanceof Host.Failure;

/**
 * A failure the program reads. Each message comes from the response status or the service's own
 * `{ message }` body, never from the request, so the device key cannot reach a program or a log.
 */
const failureOf =
  (path: string) =>
  (error: CallError): HostFailure => {
    if (isHostFailure(error)) {
      return error;
    }
    if (HttpClientError.isHttpClientError(error)) {
      const status = error.response?.status;
      return status === undefined
        ? Host.fail("Unreachable", `${path}: Orbis did not answer`)
        : Host.fail("RequestFailed", `${path}: Orbis answered ${status}`);
    }
    if (Schema.isSchemaError(error)) {
      return Host.fail(
        "InvalidAnswer",
        `${path}: the answer does not match the contract`
      );
    }
    return Host.fail("Refused", `${path}: ${error.message}`);
  };

const capability = <I, IE, O, OE>(spec: {
  readonly namespace: Namespace;
  readonly name: string;
  readonly description: string;
  readonly input: Schema.Codec<I, IE>;
  readonly output: Schema.Codec<O, OE>;
  readonly run: (
    input: I,
    client: OrbisApiClient
  ) => Effect.Effect<O, CallError>;
}): Capability => {
  const path = `${spec.namespace}.${spec.name}`;
  const decode = Schema.decodeUnknownEffect(spec.input);
  const encode = Schema.encodeEffect(Schema.toCodecJson(spec.output));
  return {
    call: (input) =>
      decode(input ?? {}).pipe(
        Effect.mapError((issue) =>
          Host.fail("InvalidInput", `${path}: ${issue.message}`)
        ),
        Effect.flatMap((decoded) =>
          Effect.gen(function* callOrbis() {
            const client = yield* OrbisClient;
            return yield* spec
              .run(decoded, client)
              .pipe(Effect.mapError(failureOf(path)));
          })
        ),
        Effect.flatMap((value) =>
          encode(value).pipe(
            Effect.mapError((issue) =>
              Host.fail("InvalidOutput", `${path}: ${issue.message}`)
            )
          )
        )
      ),
    description: spec.description,
    input: spec.input,
    name: spec.name,
    namespace: spec.namespace,
    output: spec.output,
    path,
  };
};

/**
 * A value as JSON would carry it, through `JSON.stringify` and back: no class instance crosses to
 * a program, and a key whose value is `undefined` is left out.
 */
export const plain = flow(
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown)),
  Schema.decodeSync(Schema.fromJsonString(Schema.Json))
);

const NoInput = Schema.Struct({});
const ById = Schema.Struct({ id: Schema.String });
const Words = Schema.optionalKey(Schema.String);
const Source = Schema.optionalKey(SavedSetSchema.fields.source);

// sets

const setCapabilities = [
  capability({
    description:
      "The caller's library, newest first. Every filter is optional: `tag` keeps Sets with all of the tags, `q` matches words in the title or creator, `source`, `creatorId` and `playlistId` match exactly.",
    input: Schema.Struct({
      creatorId: Words,
      playlistId: Words,
      q: Words,
      source: Source,
      tag: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
    name: "list",
    namespace: "sets",
    output: LibraryResponseSchema,
    run: (query, client) => client.sets.list({ query }),
  }),
  capability({
    description: "One Set by id, with its library entry.",
    input: ById,
    name: "read",
    namespace: "sets",
    output: SetPageSchema,
    run: (params, client) => client.sets.read({ params }),
  }),
  capability({
    description: "One Set's tracklist and how it was found.",
    input: ById,
    name: "tracklist",
    namespace: "sets",
    output: TracklistSchema,
    run: (params, client) => client.sets.tracklist({ params }),
  }),
  capability({
    description:
      "One Set's audio state: `none`, `queued`, `downloading`, `ready`, `failed` or `canceled`, with bytes received and total. Use it to find Sets that cannot play.",
    input: ById,
    name: "audioState",
    namespace: "sets",
    output: AudioStateSchema,
    run: (params, client) => client.sets.audioState({ params }),
  }),
];

// playlists

const playlistCapabilities = [
  capability({
    description: "The Playlists the caller created, with their Set counts.",
    input: NoInput,
    name: "list",
    namespace: "playlists",
    output: Schema.Struct({ playlists: Schema.Array(PlaylistSchema) }),
    run: (_, client) => client.playlists.list(),
  }),
  capability({
    description:
      "Playlists another Person created and shared with the caller, with who created each.",
    input: NoInput,
    name: "shared",
    namespace: "playlists",
    output: Schema.Struct({ playlists: Schema.Array(SharedPlaylistSchema) }),
    run: (_, client) => client.playlists.shared(),
  }),
  capability({
    description:
      "One Playlist by id, with its Sets in order and the caller's role.",
    input: ById,
    name: "read",
    namespace: "playlists",
    output: PlaylistDetailSchema,
    run: (params, client) => client.playlists.read({ params }),
  }),
];

// library

const libraryCapabilities = [
  capability({
    description: "Every tag on the caller's Sets.",
    input: NoInput,
    name: "tags",
    namespace: "library",
    output: Schema.Struct({ tags: Schema.Array(Schema.String) }),
    run: (_, client) => client.library.tags(),
  }),
  capability({
    description:
      "The caller's most-heard Sets over `range` (`month`, `quarter` or `year`; default `month`), most heard first.",
    input: Schema.Struct({ range: Schema.optionalKey(ListeningRangeSchema) }),
    name: "heavyRotation",
    namespace: "library",
    output: LibraryResponseSchema,
    run: (query, client) => client.library.heavyRotation({ query }),
  }),
  capability({
    description:
      "The caller's Collections: saved filters by tag, source, creator, range and minimum minutes heard.",
    input: NoInput,
    name: "collections",
    namespace: "library",
    output: Schema.Struct({ collections: Schema.Array(CollectionSchema) }),
    run: (_, client) => client.library.collections(),
  }),
  capability({
    description:
      "The Sets one Collection admits now, ranked as Heavy Rotation is.",
    input: ById,
    name: "collectionSets",
    namespace: "library",
    output: LibraryResponseSchema,
    run: (params, client) => client.library.collectionSets({ params }),
  }),
];

// queue

const queueCapabilities = [
  capability({
    description:
      "The caller's Listening Queue: the Sets in order and the one playing. Each Set carries its resume position.",
    input: NoInput,
    name: "read",
    namespace: "queue",
    output: Schema.Struct({ queue: ListeningQueueSchema }),
    run: (_, client) => client.queue.read(),
  }),
];

// people

const personId = Schema.Struct({ id: Schema.String });

/** The listens query with only the keys the program gave. */
interface ListensQuery {
  before?: string;
  limit?: number;
}

const listensQuery = (
  before: string | undefined,
  limit: number | undefined
): ListensQuery => {
  const query: ListensQuery = {};
  if (before !== undefined) {
    query.before = before;
  }
  if (limit !== undefined) {
    query.limit = limit;
  }
  return query;
};

const peopleCapabilities = [
  capability({
    description: "The caller: id, username, and whether they are the Host.",
    input: NoInput,
    name: "me",
    namespace: "people",
    output: MeSchema,
    run: (_, client) => client.people.me(),
  }),
  capability({
    description: "The People the caller can see.",
    input: NoInput,
    name: "list",
    namespace: "people",
    output: Schema.Struct({
      people: Schema.Array(SharedPlaylistSchema.fields.creator),
    }),
    run: (_, client) => client.people.list(),
  }),
  capability({
    description: "The Sets of one Person the caller can see.",
    input: personId,
    name: "sets",
    namespace: "people",
    output: LibraryResponseSchema,
    run: (params, client) => client.people.sets({ params }),
  }),
  capability({
    description:
      "The Playlists of one Person the caller can see, with their Sets.",
    input: personId,
    name: "playlists",
    namespace: "people",
    output: Schema.Struct({ playlists: Schema.Array(FriendPlaylistSchema) }),
    run: (params, client) => client.people.friendPlaylists({ params }),
  }),
  capability({
    description: `One page of a Person's Listens, newest first: \`limit\` (1 to ${MAX_FRIEND_LISTENS}, default ${MAX_FRIEND_LISTENS}) and \`before\`, the last page's \`nextCursor\`.`,
    input: Schema.Struct({
      before: Schema.optionalKey(Schema.String),
      id: Schema.String,
      limit: Schema.optionalKey(
        Schema.Int.check(
          Schema.isBetween({ maximum: MAX_FRIEND_LISTENS, minimum: 1 })
        )
      ),
    }),
    name: "listens",
    namespace: "people",
    output: FriendListensSchema,
    run: ({ before, id, limit }, client) =>
      client.people.friendListens({
        params: { id },
        query: listensQuery(before, limit),
      }),
  }),
];

// curate

/** Refuses a Playlist the caller did not create: a shared Playlist is another Person's to change. */
const ownPlaylist = Effect.fnUntraced(function* ownPlaylist(
  client: OrbisApiClient,
  id: string
) {
  const { playlists } = yield* client.playlists.list();
  if (!playlists.some((playlist) => playlist.id === id)) {
    return yield* Effect.fail(
      Host.fail("Refused", `curate.setPlaylistSets: ${id} is not your Playlist`)
    );
  }
});

const curateCapabilities = [
  capability({
    description:
      "Replaces one Set's tags with `tags` (at most 20, each at most 40 characters). Read the Set first to keep its other tags.",
    input: Schema.Struct({ id: Schema.String, ...TagsPayload.fields }),
    name: "setTags",
    namespace: "curate",
    output: SavedSetSchema,
    run: ({ id, tags }, client) =>
      client.library.updateTags({ params: { id }, payload: { tags } }),
  }),
  capability({
    description:
      "Replaces the caller's Playlists that hold one Set with `playlistIds`.",
    input: Schema.Struct({ id: Schema.String, ...SetPlaylistsPayload.fields }),
    name: "setPlaylists",
    namespace: "curate",
    output: SavedSetSchema,
    run: ({ id, playlistIds }, client) =>
      client.playlists.replaceSetPlaylists({
        params: { id },
        payload: { playlistIds },
      }),
  }),
  capability({
    description: "Creates an empty Playlist named `name`.",
    input: PlaylistNamePayload,
    name: "createPlaylist",
    namespace: "curate",
    output: PlaylistSchema,
    run: (payload, client) => client.playlists.create({ payload }),
  }),
  capability({
    description: "Renames one of the caller's Playlists.",
    input: Schema.Struct({ id: Schema.String, ...PlaylistNamePayload.fields }),
    name: "renamePlaylist",
    namespace: "curate",
    output: PlaylistSchema,
    run: ({ id, name }, client) =>
      client.playlists.rename({ params: { id }, payload: { name } }),
  }),
  capability({
    description:
      "Replaces the Sets of one Playlist the caller created with `setIds`, in that order. A shared Playlist is refused.",
    input: Schema.Struct({
      id: Schema.String,
      ...PlaylistMembersPayload.fields,
    }),
    name: "setPlaylistSets",
    namespace: "curate",
    output: LibraryResponseSchema,
    run: ({ id, setIds }, client) =>
      ownPlaylist(client, id).pipe(
        Effect.andThen(
          client.playlists.replaceMembers({
            params: { id },
            payload: { setIds },
          })
        )
      ),
  }),
  capability({
    description:
      "Creates a Collection, a smart playlist: Sets heard over `range` for at least `minimumMinutes`, filtered by `tag`, `source` and `creatorId` (null admits all).",
    input: CollectionPayload,
    name: "createCollection",
    namespace: "curate",
    output: CollectionSchema,
    run: (payload, client) => client.library.createCollection({ payload }),
  }),
  capability({
    description: "Replaces one Collection's name and filter.",
    input: Schema.Struct({ id: Schema.String, ...CollectionPayload.fields }),
    name: "updateCollection",
    namespace: "curate",
    output: CollectionSchema,
    run: ({ id, ...payload }, client) =>
      client.library.updateCollection({ params: { id }, payload }),
  }),
];

/** Every capability, in namespace order. */
export const catalog: readonly Capability[] = [
  ...setCapabilities,
  ...playlistCapabilities,
  ...libraryCapabilities,
  ...queueCapabilities,
  ...peopleCapabilities,
  ...curateCapabilities,
];
