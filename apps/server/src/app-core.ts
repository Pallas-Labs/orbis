import { normalizeSourceUrl, youTubePlaylistId } from "@orbis/contracts";
import type { PlaylistImport, SavedSet } from "@orbis/contracts";
import type {
  ChangeTopic,
  SaveSetResultSchema,
} from "@orbis/contracts/http-api";
import {
  decodePlaybackDiagnosticsBatch,
  AdminKeyPayload,
  AdminPersonPayload,
  ApprovalCodePayload,
  CollaborationPayload,
  ImportPlaylistPayload,
  JoinPayload,
  RedeemSignInCodePayload,
  SaveSetPayload,
  OrbisApi,
  PlaylistMembersPayload,
  PlaylistEditorsPayload,
  PlaylistNamePayload,
  PositionPayload,
  PresenceActionPayload,
  QueueEntryPayload,
  QueuePlaylistPayload,
  QueueSetPayload,
  SetAccess,
  SetCaller,
  SetPlaylistsPayload,
  SocialFiltersPayload,
  StartApprovalRequestPayload,
  TagsPayload,
  UpdateTitlePayload,
  UpdateMePayload,
  WaitApprovalRequestPayload,
} from "@orbis/contracts/http-api";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  PubSub,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect";
import {
  Headers,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import {
  addKey,
  addPerson,
  AdminError,
  collectApprovalKey,
  issueSignInCode,
  joinGroup,
  listDevices,
  listKeys,
  listPeople,
  closeJoining,
  newPasscode,
  readPasscode,
  redeemSignInCode,
  removePerson,
  revokeDevice,
  revokeKey,
} from "./admin.js";
import {
  appleMusicDownloadRefused,
  appleMusicSearchRefusal,
} from "./apple-music.js";
import { makeApprovalRequests } from "./approval-requests.js";
import { makeAttemptLimiter } from "./attempt-limiter.js";
import { Audio } from "./audio-service.js";
import type { AudioFile } from "./audio-service.js";
import { ClientAddress } from "./client-address.js";
import { insertBatches } from "./db/batches.js";
import {
  listens,
  playlistEditors,
  playlistSets,
  playlists,
  sets as setRows,
} from "./db/schema.js";
import { Database } from "./db/service.js";
import { asLibraryError, LibraryError } from "./errors.js";
import type {
  AccessDecision,
  AccessMode,
  PersonRecord,
  TrustStore,
} from "./identity.js";
import {
  decideAccess,
  HOST_PERSON_ID,
  markKeyUsed,
  readTrustRegistry,
  updatePerson,
  updatePersonFilters,
} from "./identity.js";
import { Library } from "./library.js";
import type { LoggedRecord, LoggingOptions } from "./logging.js";
import {
  annotateForwardedRequest,
  annotateWideEvent,
  configureLogging,
  finishRequestLog,
  loggingLayer,
  makeRequestLogMiddleware,
  safeRequestPath,
  startRequestLog,
  withWideEvent,
} from "./logging.js";
import type { MetadataError } from "./metadata-error.js";
import { Metadata } from "./metadata.js";
import type { EnrichedMetadata, PlaylistTrack } from "./metadata.js";
import {
  makePlaybackDiagnosticsRelay,
  readBoundedBody,
  PlaybackBodyLimitError,
} from "./playback-diagnostics.js";
import type { PlaybackDiagnosticsOptions } from "./playback-diagnostics.js";
import {
  PlaylistImporter,
  playlistImportRefusal,
} from "./playlist-importer.js";
import type { PlaylistImporterOptions } from "./playlist-importer.js";
import { PresenceJournal } from "./presence-journal.js";
import { Presence } from "./presence.js";
import type { PresenceOptions } from "./presence.js";
import { QueueSignals } from "./queue-signals.js";
import { Queue } from "./queue.js";
import { expandShortLink } from "./short-link.js";
import { Stats } from "./stats.js";
import { checkStreamGrant, issueStreamGrant } from "./stream-grant-core.js";
import type { StreamGrantVerdict } from "./stream-grant-core.js";
import type { TitleReviserError } from "./title-reviser-error.js";
import { TitleReviser } from "./title-reviser.js";
import {
  claimTracklist,
  readTracklist,
  runClaimedTracklist,
} from "./tracklists.js";
import type { TracklistClaim } from "./tracklists.js";
import { trustOperation } from "./trust-storage.js";
import { Versos } from "./versos.js";
import {
  listFilterablePeople,
  resolveVisiblePerson,
  resolveVisibleSet,
} from "./visibility.js";

interface RawFilters {
  creatorId?: string | null;
  playlistId: string;
  q: string;
  tags: string[];
  source?: string | null;
}

class AcceptedAccess extends Context.Service<
  AcceptedAccess,
  Exclude<AccessDecision, { readonly kind: "rejected" }>
>()("Orbis/AcceptedAccess") {}

/** A request that presents a stream grant, and what checking it decided. */
interface StreamAccess {
  readonly set: string;
  readonly grant: StreamGrantVerdict["kind"] | "unknown-person";
  readonly decision: AccessDecision;
}

const grantAccess = (
  request: Request,
  mode: AccessMode,
  store: TrustStore,
  secret: Buffer
): StreamAccess | null => {
  if (mode !== "device" || request.method !== "GET") {
    return null;
  }
  const url = new URL(request.url);
  const match = /^\/sets\/(?<id>[^/]+)\/audio$/u.exec(url.pathname);
  if (!match?.groups?.id || !url.searchParams.has("grant")) {
    return null;
  }
  const set = decodeURIComponent(match.groups.id);
  const verdict = checkStreamGrant(secret, set, url.searchParams.get("grant"));
  const person =
    verdict.kind === "valid"
      ? store.people.find(
          (candidate) => candidate.id === verdict.personId && !candidate.removed
        )
      : undefined;
  if (person) {
    return {
      decision: { keyId: null, kind: "accepted", person },
      grant: verdict.kind,
      set,
    };
  }
  return {
    decision: {
      kind: "rejected",
      message: "Invalid stream grant.",
      statusCode: 401,
    },
    grant: verdict.kind === "valid" ? "unknown-person" : verdict.kind,
    set,
  };
};

const rejectedStreamGrant = (request: Request, access: StreamAccess | null) =>
  new URL(request.url).searchParams.has("grant") &&
  access?.decision.kind !== "accepted";

const annotateAudio = (fields: LoggedRecord) =>
  annotateWideEvent({ audio: fields });

/** How the audio route answered, for the request's wide event. */
const audioDelivery = (response: HttpServerResponse.HttpServerResponse) => {
  if (response.status !== 302) {
    return { result: "served" };
  }
  const location = response.headers.location ?? "";
  // The origin alone: the redirect's query string carries the grant.
  return { node: URL.parse(location)?.origin ?? null, result: "redirected" };
};

const forwardedResponse = (
  request: Request,
  response: Response,
  store: TrustStore,
  keyId: string | null
) => {
  if (request.headers.get("x-orbis-ingress") === "funnel-forward") {
    const key = store.keys.find((record) => record.id === keyId);
    if (key) {
      response.headers.set("x-orbis-key-label", encodeURIComponent(key.label));
    }
  }
  return response;
};

const ownDevices = (personId: string) => (viewerId: string) =>
  Effect.succeed(viewerId === personId);

const meBody = (person: PersonRecord) => ({
  autoDownload: person.autoDownload ?? true,
  host: person.id === HOST_PERSON_ID,
  id: person.id,
  social: person.social ?? false,
  username: person.username,
});

const PRESENCE_WINDOW_MS = 30_000;
const TOO_MANY_ATTEMPTS = "Too many invalid keys.";
const tooManyAttempts = () =>
  Response.json({ message: TOO_MANY_ATTEMPTS }, { status: 429 });
const tooManyAttemptsFailure = () =>
  new LibraryError({ message: TOO_MANY_ATTEMPTS, statusCode: 429 });
/**
 * Routes a new device calls before it has a key (ADR 0020). They run whatever
 * the Authorization header says, so a key cannot skip the failed-key limit.
 * Most count as a sign-in attempt before they run. A wait counts only when its
 * secret is unknown, so a device waiting on its own Approval Request never
 * locks itself out.
 */
const OPEN_ROUTES: ReadonlyMap<string, "counted" | "counts-failures"> = new Map(
  [
    ["/sign-in/code", "counted"],
    ["/sign-in/join", "counted"],
    ["/sign-in/requests", "counted"],
    ["/sign-in/requests/wait", "counts-failures"],
  ]
);
const APPROVER_ROUTES: ReadonlySet<string> = new Set([
  "/me/sign-in-requests/approve",
  "/me/sign-in-requests/find",
]);
/**
 * The router also matches a path with repeated or trailing slashes, other
 * casing, or percent-encoding, so the route lookups see the same
 * spelling the router does. Otherwise a guess on `/sign-in/code/` would run
 * without being counted.
 */
const routePath = (url: string): string => {
  const raw = new URL(url).pathname;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  return decoded
    .toLowerCase()
    .replaceAll(/\/+/gu, "/")
    .replace(/(?<=.)\/$/u, "");
};
/** A signed-out approver gets 401, so the app knows to sign in first. */
const refusalFor = (
  request: Request,
  decision: { readonly message: string; readonly statusCode: number }
) =>
  request.headers.get("authorization") === null &&
  request.method === "POST" &&
  APPROVER_ROUTES.has(routePath(request.url))
    ? { message: "Sign in to approve a device.", statusCode: 401 }
    : decision;
const EXPIRED_APPROVAL = "That sign-in request expired. Start again.";
const expiredApproval = () =>
  new LibraryError({ message: EXPIRED_APPROVAL, statusCode: 404 });
const invalidSignInCode = () =>
  new LibraryError({
    message: "That code is not valid. Get a new one.",
    statusCode: 404,
  });
const Tags = TagsPayload.fields.tags;
const Filters = Schema.Struct({
  creatorId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100))),
  playlistId: Schema.String.check(Schema.isMaxLength(100)),
  q: Schema.String.check(Schema.isMaxLength(200)),
  source: Schema.optionalKey(
    Schema.Literals(["youtube", "soundcloud", "apple-music"])
  ),
  tags: Tags,
});
const decodeFiltersEffect = Schema.decodeUnknownEffect(Filters);

const logDetailsFailure = (set: SavedSet, reason: string) =>
  Effect.logWarning("set details fill failed").pipe(
    Effect.annotateLogs({ reason, set: set.id })
  );

/**
 * A failed library call is the one server-side failure the response status does not
 * explain on its own, so it is logged with the status the client receives. A rejected
 * request body is not logged: its 400 already appears on the request event.
 */
const logLibraryFailure = <E>(error: E) => {
  if (!(error instanceof LibraryError)) {
    return Effect.void;
  }
  const logFailure =
    error.statusCode >= 500 ? Effect.logError : Effect.logWarning;
  return logFailure("library request failed").pipe(
    Effect.annotateLogs({ errorTag: error._tag, status: error.statusCode })
  );
};

const failureResponse = <E>(error: E) => {
  if (error instanceof LibraryError) {
    return HttpServerResponse.jsonUnsafe(
      { message: error.message },
      { status: error.statusCode }
    );
  }
  return HttpServerResponse.jsonUnsafe(
    { message: "Check your request fields and send valid JSON." },
    { status: 400 }
  );
};

const fromAdminError = (cause: unknown) =>
  new LibraryError({
    message:
      cause instanceof AdminError
        ? cause.message
        : "The trust store is unavailable.",
    statusCode: cause instanceof AdminError ? cause.statusCode : 500,
  });

/** Approval Codes and secrets are credentials: no proxy or browser may keep them. */
const uncached = <A>(body: A, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, {
    headers: { "cache-control": "no-store" },
    status,
  });

const trustUnavailable = () =>
  new LibraryError({
    message: "The trust store is unavailable.",
    statusCode: 500,
  });

/** What a change becomes on one `/events?changes=1` stream; null when it is not for that stream. */
type ChangeFrame =
  | { readonly kind: "changed"; readonly topic: ChangeTopic }
  | { readonly kind: "playlistImport"; readonly playlistImport: PlaylistImport }
  | null;

const missingPlaylist = () =>
  new LibraryError({ message: "Playlist not found.", statusCode: 404 });

const withFailureResponse = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.match(effect.pipe(Effect.tapError(logLibraryFailure)), {
    onFailure: failureResponse,
    onSuccess: (body) => body,
  });

export const createPortableApp = (options: {
  audio: Layer.Layer<Audio, never, Library>;
  audioResponse: (
    file: AudioFile,
    range: string | undefined,
    setId: string,
    personId: string,
    grant: string | null
  ) => HttpServerResponse.HttpServerResponse;
  releaseAudio: (id: string) => Effect.Effect<void, LibraryError, Database>;
  streamSecret: Buffer;
  database: Layer.Layer<Database, unknown>;
  trustPath?: string | undefined;
  logging?: LoggingOptions;
  playbackDiagnostics?: PlaybackDiagnosticsOptions;
  recordKeyUse?: boolean;
  metadata?: Layer.Layer<Metadata>;
  /** How long after a Playback Position report a Person still counts as listening. */
  presenceWindowMs?: number;
  presence?: PresenceOptions & { journal?: Layer.Layer<PresenceJournal> };
  playlistImports?: Pick<PlaylistImporterOptions, "heartbeat" | "retry">;
  /** The clock Sign-in Codes and Approval Requests expire by. Tests move it to prove expiry. */
  signInCodeNow?: () => number;
  /** How long a wait on an Approval Request stays open; 25 seconds by default. */
  approvalWaitMs?: number;
  /** How long an Approval Request lives; 2 minutes by default. A lane shortens it to show a new code. */
  approvalLifetimeMs?: number | undefined;
  /** Follows short links such as `on.soundcloud.com`. Tests pass a stub to stay offline. */
  shortLinkFetch?: (url: string, signal: AbortSignal) => Promise<Response>;
  titleReviser?: Layer.Layer<TitleReviser>;
  versos?: Layer.Layer<Versos>;
}) => {
  configureLogging(options.logging);
  const { trustPath } = options;
  const { streamSecret } = options;
  const attempts = makeAttemptLimiter();
  const relayPlayback = makePlaybackDiagnosticsRelay(
    options.playbackDiagnostics
  );
  const signInCodeNow = options.signInCodeNow ?? Date.now;
  const approvals = makeApprovalRequests(
    signInCodeNow,
    options.approvalLifetimeMs
  );
  const approvalWaitMs = options.approvalWaitMs ?? 25_000;
  const { database } = options;
  const libraryOptions = {
    people: () => readTrustRegistry(trustPath).store.people,
    releaseAudio: options.releaseAudio,
  };
  const libraryLayer = Library.forPersonLayer("host", libraryOptions).pipe(
    Layer.provide(database)
  );
  const queueSignalsLayer = QueueSignals.layer;
  const presenceNow = options.presence?.now ?? Date.now;
  const presenceLayer = Presence.layer({
    ...options.presence,
    legacyReportWindowMs: options.presenceWindowMs ?? PRESENCE_WINDOW_MS,
  }).pipe(
    Layer.provide(database),
    Layer.provide(options.presence?.journal ?? PresenceJournal.unrecorded)
  );
  let presenceService: typeof Presence.Service | null = null;
  let importerService: typeof PlaylistImporter.Service | null = null;
  const routes = Layer.effectDiscard(
    Effect.gen(function* registerRoutes() {
      const library = yield* Library;
      const db = yield* Database;
      const presence = yield* Presence;
      presenceService = presence;
      const audio = yield* Audio;
      const metadata = yield* Metadata;
      const titleReviser = yield* TitleReviser;
      const versos = yield* Versos;
      const scope = yield* Scope.Scope;
      const signals = yield* QueueSignals;
      // Every open `/events` stream reads this hub. A `changed` entry decides its own
      // recipients when delivered; `access` makes each stream recheck its key.
      const changes = yield* PubSub.unbounded<
        | {
            readonly kind: "changed";
            readonly topic: ChangeTopic;
            readonly reaches: (viewerId: string) => Effect.Effect<boolean>;
          }
        | {
            readonly kind: "playlistImport";
            readonly personId: string;
            readonly playlistImport: PlaylistImport;
          }
        | { readonly kind: "access" }
      >();
      const announce = (
        topic: ChangeTopic,
        reaches: (viewerId: string) => Effect.Effect<boolean>
      ) => PubSub.publish(changes, { kind: "changed", reaches, topic });
      const recheckAccess = () => PubSub.publish(changes, { kind: "access" });
      const seesPerson = (personId: string) => (viewerId: string) =>
        Effect.sync(() => {
          if (viewerId === personId) {
            return true;
          }
          try {
            resolveVisiblePerson(
              readTrustRegistry(trustPath).store.people,
              viewerId,
              personId
            );
            return true;
          } catch {
            return false;
          }
        });
      const readsSet = (setId: string) => (viewerId: string) =>
        resolveVisibleSet({
          id: setId,
          people: readTrustRegistry(trustPath).store.people,
          personId: viewerId,
        }).pipe(
          Effect.provideService(Database, db),
          Effect.as(true),
          Effect.orElseSucceed(() => false)
        );
      const announceForCaller = Effect.fn("App.announceForCaller")(
        function* announceCallerChange(
          topic: ChangeTopic,
          reaches: (
            personId: string
          ) => (viewerId: string) => Effect.Effect<boolean>
        ) {
          const caller = yield* SetCaller;
          yield* announce(topic, reaches(caller.person.id));
        }
      );
      // A refresh reads the source again, since its description may have gained a tracklist
      // after the save. A failed read keeps the stored description for Versos to scan again.
      const rereadDescription = (claim: TracklistClaim) => {
        const keepDescription = (reason: string) =>
          Effect.logWarning("set details refresh failed").pipe(
            Effect.annotateLogs({ reason, set: claim.id }),
            Effect.as(claim.description)
          );
        return metadata.details({ source: claim.source, url: claim.url }).pipe(
          Effect.tap((details) => library.recordDetails(claim.id, details)),
          Effect.map((details) => details.description),
          Effect.catchTags({
            LibraryError: (error) => keepDescription(error.message),
            MetadataError: (error) => keepDescription(error.reason),
          })
        );
      };
      const runningTracklists = new Set<string>();
      const startTracklist = Effect.fn("SaveSet.startTracklist")(
        (id: string, start: "first" | "retry" | "refresh" = "first") =>
          Effect.gen(function* startSavedSetTracklist() {
            if (runningTracklists.has(id)) {
              return;
            }
            runningTracklists.add(id);
            let handedOff = false;
            yield* Effect.gen(function* launchTracklist() {
              const claim = yield* claimTracklist(id, start !== "first").pipe(
                Effect.provideService(Database, db)
              );
              if (!claim) {
                return;
              }
              yield* runClaimedTracklist(
                claim,
                start === "refresh" ? rereadDescription(claim) : undefined
              ).pipe(
                Effect.interruptible,
                Effect.provideService(Database, db),
                Effect.provideService(Versos, versos),
                withWideEvent({ job: "tracklist", set: id }, options.logging),
                Effect.ensuring(
                  Effect.sync(() => {
                    runningTracklists.delete(id);
                  })
                ),
                Effect.forkIn(scope, { startImmediately: true })
              );
              handedOff = true;
            }).pipe(
              Effect.uninterruptible,
              Effect.ensuring(
                Effect.sync(() => {
                  if (!handedOff) {
                    runningTracklists.delete(id);
                  }
                })
              )
            );
          })
      );
      const reviseTitle = Effect.fn("SaveSet.reviseTitle")((
        set: SavedSet,
        enriched: EnrichedMetadata
      ) => {
        const keepProviderTitle = (error: TitleReviserError) =>
          Effect.logWarning("set title revision failed").pipe(
            Effect.annotateLogs({ reason: error.reason, set: set.id }),
            Effect.as(enriched)
          );
        return titleReviser
          .revise({
            creator: enriched.creator,
            source: set.source,
            title: enriched.title,
          })
          .pipe(
            Effect.map((title) => ({ ...enriched, title })),
            // A revision failure keeps the provider title: a bad rename must
            // never fail enrichment, which already has a retry path.
            Effect.catchTag("TitleReviserError", keepProviderTitle)
          );
      });
      // The slow yt-dlp read runs after the response, tied to the app so `dispose` stops it. A
      // failure is logged and marks the Set's details failed; the save itself is unaffected.
      const fillDetails = Effect.fn("SaveSet.fillDetails")((set: SavedSet) =>
        metadata.details({ source: set.source, url: set.url }).pipe(
          Effect.flatMap((details) => library.recordDetails(set.id, details)),
          Effect.tap(() => startTracklist(set.id)),
          Effect.catchTags({
            LibraryError: (error) => logDetailsFailure(set, error.message),
            MetadataError: (error) =>
              error.reason === "not-configured"
                ? Effect.void
                : logDetailsFailure(set, error.reason).pipe(
                    Effect.andThen(
                      library.recordDetailsFailure(set.id).pipe(
                        Effect.ignore({
                          log: "Warn",
                          message: "set details failure not recorded",
                        })
                      )
                    )
                  ),
          }),
          withWideEvent({ job: "set-details", set: set.id }, options.logging),
          Effect.forkIn(scope),
          Effect.asVoid
        )
      );
      // Stores provider metadata, then reads details unless the yt-dlp fallback already did.
      const recordMetadata = (
        set: SavedSet,
        personal: typeof Library.Service,
        enriched: EnrichedMetadata
      ) =>
        library.recordEnrichment(set.id, enriched).pipe(
          Effect.tap(() => {
            if (enriched.songs) {
              return Effect.void;
            }
            return enriched.extras ? startTracklist(set.id) : fillDetails(set);
          }),
          Effect.flatMap(() => personal.find(set.id))
        );
      // Enrichment failure is swallowed so the save still succeeds, so it is the
      // one outcome a client cannot see. The log records which set and which reason.
      const enrichSavedSet = Effect.fn("SaveSet.enrich")((
        set: SavedSet,
        personal: typeof Library.Service,
        read: Effect.Effect<EnrichedMetadata, MetadataError> = metadata.enrich({
          source: set.source,
          url: set.url,
        })
      ) => {
        const onMetadataFailure = (error: MetadataError) =>
          Effect.logWarning("set metadata enrichment failed").pipe(
            Effect.annotateLogs({ reason: error.reason, set: set.id }),
            Effect.andThen(library.recordEnrichmentFailure(set.id)),
            // yt-dlp and Versos cannot read Apple Music; a retry reads the album again.
            Effect.tap(() =>
              set.source === "apple-music" ? Effect.void : fillDetails(set)
            ),
            Effect.flatMap(() => personal.find(set.id))
          );
        return read.pipe(
          // Apple names its albums cleanly; there is no upload title to tidy.
          Effect.flatMap((enriched) =>
            set.source === "apple-music"
              ? Effect.succeed(enriched)
              : reviseTitle(set, enriched)
          ),
          Effect.flatMap((enriched) => recordMetadata(set, personal, enriched)),
          Effect.catchTag("MetadataError", onMetadataFailure)
        );
      });
      // The one read that can refuse a save (ADR 0021): an album missing from the US catalog
      // makes no Set, so a link no Set holds yet is read before the Set exists.
      const readAlbumBeforeSave = Effect.fn("SaveSet.readAlbum")(
        function* readAlbumBeforeSave(input: string) {
          const link = Option.getOrUndefined(
            Option.liftThrowable(normalizeSourceUrl)(input)
          );
          if (link?.source !== "apple-music") {
            return null;
          }
          const [existing] = yield* db
            .select({ id: setRows.id })
            .from(setRows)
            .where(eq(setRows.url, link.url))
            .limit(1);
          if (existing) {
            return null;
          }
          const read = yield* Effect.result(metadata.enrich(link));
          if (Result.isFailure(read) && read.failure.reason === "not-found") {
            return yield* Effect.fail(
              new LibraryError({
                message: read.failure.message,
                statusCode: 400,
              })
            );
          }
          return Effect.fromResult(read);
        }
      );
      const autoDownloadSaved = Effect.fn("AutoDownload.onSave")(
        function* autoDownloadSaved(saved: SavedSet, person: PersonRecord) {
          const result = (
            autoDownloadResult: (typeof SaveSetResultSchema.Type)["autoDownloadResult"],
            set?: SavedSet
          ) => ({ ...(set ?? saved), autoDownloadResult });
          if (saved.source === "apple-music") {
            return result("unavailable");
          }
          if (person.autoDownload === false) {
            return result("disabled");
          }
          if (saved.downloadState === "ready") {
            return result("ready");
          }
          if (
            saved.downloadState === "queued" ||
            saved.downloadState === "downloading"
          ) {
            return result("inProgress");
          }
          if (!audio.isConfigured) {
            return result("unavailable");
          }
          return yield* audio.requestDownload(saved.id).pipe(
            Effect.map(({ set, accepted }) =>
              result(accepted ? "queued" : "inProgress", set)
            ),
            Effect.catchTag("LibraryError", (error) =>
              error.statusCode === 429
                ? Effect.succeed(result("queueFull"))
                : Effect.fail(error)
            )
          );
        }
      );
      const libraryFor = (personId: string) =>
        Library.forPersonLayer(personId, libraryOptions).pipe(
          Layer.provide(Layer.succeed(Database, db))
        );
      // Titles skip revision here: it is one model call per track.
      const importTrack = Effect.fn("PlaylistImport.saveTrack")(
        function* importTrack(personId: string, track: PlaylistTrack) {
          const person = readTrustRegistry(trustPath).store.people.find(
            (candidate) => candidate.id === personId && !candidate.removed
          );
          if (!person) {
            return yield* Effect.fail(
              new LibraryError({
                message: "The Person who started this import was removed.",
                statusCode: 404,
              })
            );
          }
          const personal = yield* Library;
          const saved = yield* personal
            .save({ tags: [], title: "", url: track.url })
            .pipe(
              Effect.catchIf(
                (error) => error.statusCode === 409,
                () => personal.findByUrl(track.url)
              )
            );
          const known =
            saved.titleEditedByUser || saved.metadataState === "enriched";
          return yield* autoDownloadSaved(
            known
              ? saved
              : yield* recordMetadata(saved, personal, track.metadata),
            person
          );
        },
        (effect, personId) =>
          effect.pipe(
            Effect.provide(libraryFor(personId)),
            asLibraryError("Could not save a track of the playlist.")
          )
      );
      const importer = Context.get(
        yield* Layer.buildWithScope(
          PlaylistImporter.layer({
            ...options.playlistImports,
            publish: (personId, playlistImport) =>
              Effect.all([
                PubSub.publish(changes, {
                  kind: "playlistImport",
                  personId,
                  playlistImport,
                }),
                announce("library", ownDevices(personId)),
                announce("playlist", seesPerson(personId)),
              ]).pipe(Effect.asVoid),
            saveTrack: importTrack,
          }),
          scope
        ),
        PlaylistImporter
      );
      importerService = importer;
      const setGroup = HttpApiBuilder.group(OrbisApi, "sets", (handlers) =>
        handlers
          .handleRaw("requestDownload", ({ params }) =>
            Effect.match(
              Effect.gen(function* requestPersonalDownload() {
                const personal = yield* Library;
                const current = yield* personal.find(params.id);
                if (current.source === "apple-music") {
                  return yield* Effect.fail(appleMusicDownloadRefused());
                }
                const result = yield* audio.requestDownload(params.id);
                return { ...result, set: yield* personal.find(params.id) };
              }).pipe(
                Effect.tap(() => announce("set", readsSet(params.id))),
                Effect.tapError(logLibraryFailure)
              ),
              {
                onFailure: failureResponse,
                onSuccess: ({ accepted, set }) =>
                  HttpServerResponse.jsonUnsafe(set, {
                    status: accepted ? 202 : 200,
                  }),
              }
            )
          )
          .handle("audioState", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* personalAudioState() {
                const personal = yield* Library;
                yield* personal.find(params.id);
                return yield* audio.audioState(params.id);
              })
            )
          )
          .handleRaw("audioGrant", ({ params }) =>
            Effect.gen(function* grantAudio() {
              const caller = yield* SetCaller;
              const result = yield* Effect.match(audio.audioFile(params.id), {
                onFailure: failureResponse,
                onSuccess: () =>
                  HttpServerResponse.jsonUnsafe({
                    url: `/sets/${encodeURIComponent(params.id)}/audio?grant=${issueStreamGrant(streamSecret, params.id, caller.person.id)}`,
                  }),
              });
              return result;
            })
          )
          .handleRaw("audio", ({ params, request }) =>
            Effect.gen(function* serveAudio() {
              const caller = yield* SetCaller;
              yield* annotateAudio({
                person: caller.person.id,
                set: params.id,
              });
              return yield* Effect.match(
                Effect.gen(function* personalAudioFile() {
                  const personal = yield* Library;
                  const set = yield* personal.find(params.id).pipe(
                    Effect.tapError(() =>
                      annotateAudio({
                        reason: "set-not-found",
                        result: "refused",
                      })
                    )
                  );
                  yield* annotateAudio({ downloadState: set.downloadState });
                  return yield* audio
                    .audioFile(params.id)
                    .pipe(
                      Effect.tapError(() =>
                        annotateAudio({ reason: "no-audio", result: "refused" })
                      )
                    );
                }).pipe(
                  Effect.map((file) =>
                    options.audioResponse(
                      file,
                      Option.getOrUndefined(
                        Headers.get(request.headers, "range")
                      ),
                      params.id,
                      caller.person.id,
                      new URL(request.url, "http://localhost").searchParams.get(
                        "grant"
                      )
                    )
                  ),
                  Effect.tap((response) =>
                    annotateAudio(audioDelivery(response))
                  ),
                  Effect.tapError(logLibraryFailure)
                ),
                {
                  onFailure: failureResponse,
                  onSuccess: (response) => response,
                }
              );
            })
          )
          .handle("cancelDownload", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* cancelPersonalDownload() {
                const personal = yield* Library;
                yield* personal.find(params.id);
                yield* audio.cancelDownload(params.id);
                return yield* personal.find(params.id);
              }).pipe(Effect.tap(() => announce("set", readsSet(params.id))))
            )
          )
          .handleRaw("save", () =>
            withFailureResponse(
              Effect.gen(function* saveSet() {
                const input =
                  yield* HttpServerRequest.schemaBodyJson(SaveSetPayload);
                const url = yield* expandShortLink(
                  input.url,
                  options.shortLinkFetch
                );
                const caller = yield* SetCaller;
                const personal = yield* Library;
                const albumRead = yield* readAlbumBeforeSave(url);
                const saved = yield* personal.save({
                  tags: [...(input.tags ?? [])],
                  title: input.title ?? "",
                  url,
                });
                yield* Effect.logInfo("set saved").pipe(
                  Effect.annotateLogs({ set: saved.id, source: saved.source })
                );
                if (albumRead) {
                  return yield* autoDownloadSaved(
                    yield* enrichSavedSet(saved, personal, albumRead),
                    caller.person
                  );
                }
                // An Apple Music read brings the Tracklist with it, so a Set that has one needs
                // no read, and one that lost it (its last saver removed it) reads the album again.
                if (saved.source === "apple-music") {
                  return yield* autoDownloadSaved(
                    saved.tracklistState === "ready"
                      ? saved
                      : yield* enrichSavedSet(saved, personal),
                    caller.person
                  );
                }
                if (
                  saved.titleEditedByUser ||
                  saved.metadataState === "enriched"
                ) {
                  yield* fillDetails(saved);
                  return yield* autoDownloadSaved(saved, caller.person);
                }
                return yield* autoDownloadSaved(
                  yield* enrichSavedSet(saved, personal),
                  caller.person
                );
              }).pipe(
                Effect.tap(() => announceForCaller("library", ownDevices))
              )
            )
          )
          .handle("retryMetadata", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* retrySetMetadata() {
                const personal = yield* Library;
                const set = yield* personal.find(params.id);
                return yield* enrichSavedSet(set, personal);
              }).pipe(Effect.tap(() => announce("set", readsSet(params.id))))
            )
          )
          .handle("tracklist", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* getSetTracklist() {
                const personal = yield* Library;
                yield* personal.find(params.id);
                return yield* readTracklist(params.id).pipe(
                  Effect.provideService(Database, db)
                );
              })
            )
          )
          .handle("retryTracklist", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* retrySetTracklist() {
                const personal = yield* Library;
                const saved = yield* personal.find(params.id);
                // An Apple Music Tracklist is the album's songs, so the retry reads the album.
                if (saved.source === "apple-music") {
                  yield* enrichSavedSet(saved, personal);
                  return yield* readTracklist(params.id).pipe(
                    Effect.provideService(Database, db)
                  );
                }
                // A pending Tracklist resumes a stalled run; a running one starts nothing new.
                // Any other state is a refresh: the source is read again and Versos scans it.
                if (saved.tracklistState === "pending") {
                  const [set] = yield* db
                    .select({ detailsState: setRows.detailsState })
                    .from(setRows)
                    .where(eq(setRows.id, params.id));
                  yield* set?.detailsState === "filled"
                    ? startTracklist(params.id, "retry")
                    : fillDetails(saved);
                } else {
                  yield* startTracklist(params.id, "refresh");
                }
                return yield* readTracklist(params.id).pipe(
                  Effect.provideService(Database, db)
                );
              })
            )
          )
          .handleRaw("updateTitle", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* updateSetTitle() {
                const input =
                  yield* HttpServerRequest.schemaBodyJson(UpdateTitlePayload);
                const personal = yield* Library;
                return yield* personal.updateTitle(params.id, input.title);
              }).pipe(
                Effect.tap(() => announceForCaller("library", ownDevices))
              )
            )
          )
          .handle("remove", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* removePersonalSet() {
                const personal = yield* Library;
                const queue = yield* Queue;
                return yield* personal
                  .remove(params.id)
                  .pipe(Effect.tap(queue.notify));
              }).pipe(
                Effect.tap(() => announceForCaller("library", ownDevices))
              )
            )
          )
          .handleRaw("list", ({ request }) =>
            withFailureResponse(
              Effect.gen(function* listSets() {
                const params = new URL(request.url, "http://localhost")
                  .searchParams;
                const rawFilters: RawFilters = {
                  playlistId: params.get("playlistId") ?? "",
                  q: params.get("q") ?? "",
                  tags: params.getAll("tag"),
                };
                if (params.has("creatorId")) {
                  rawFilters.creatorId = params.get("creatorId");
                }
                if (params.has("source")) {
                  rawFilters.source = params.get("source");
                }
                const filters = yield* decodeFiltersEffect(rawFilters);
                const personal = yield* Library;
                const sets = yield* personal.list({
                  ...filters,
                  tags: [...filters.tags],
                });
                return { sets };
              })
            )
          )
      );
      const visibleFriend = Effect.fn("App.visibleFriend")(
        function* resolveFriend(id: string) {
          const caller = yield* SetCaller;
          const { people } = readTrustRegistry(trustPath).store;
          return yield* Effect.try({
            catch: (error) =>
              error instanceof LibraryError
                ? error
                : new LibraryError({
                    message: "Could not read People.",
                    statusCode: 500,
                  }),
            try: () => resolveVisiblePerson(people, caller.person.id, id),
          });
        }
      );
      const mutuallyVisibleFriend = Effect.fn("App.mutuallyVisibleFriend")(
        function* resolveMutualVisibility(id: string) {
          const caller = yield* SetCaller;
          const target = yield* visibleFriend(id);
          const { people } = readTrustRegistry(trustPath).store;
          yield* Effect.try({
            catch: (error) =>
              error instanceof LibraryError ? error : missingPlaylist(),
            try: () =>
              resolveVisiblePerson(people, target.id, caller.person.id),
          });
          return target;
        }
      );
      const ownedPlaylist = Effect.fn("App.ownedPlaylist")(
        function* findOwnedPlaylist(id: string, personId: string) {
          const [row] = yield* db
            .select({
              collaborative: playlists.collaborative,
              id: playlists.id,
            })
            .from(playlists)
            .where(and(eq(playlists.id, id), eq(playlists.creatorId, personId)))
            .limit(1);
          if (!row) {
            return yield* Effect.fail(missingPlaylist());
          }
          return row;
        }
      );
      const collaborationFor = Effect.fn("App.collaborationFor")(
        function* readCollaboration(id: string, personId: string) {
          const playlist = yield* ownedPlaylist(id, personId);
          const editors = yield* db
            .select({ editorId: playlistEditors.editorId })
            .from(playlistEditors)
            .where(eq(playlistEditors.playlistId, id));
          return {
            collaborative: playlist.collaborative,
            editorIds: editors.map((row) => row.editorId),
          };
        }
      );
      const editablePlaylistOwner = Effect.fn("App.editablePlaylistOwner")(
        function* resolveEditablePlaylist(id: string, personId: string) {
          const [owned] = yield* db
            .select({ id: playlists.id })
            .from(playlists)
            .where(and(eq(playlists.id, id), eq(playlists.creatorId, personId)))
            .limit(1);
          if (owned) {
            return personId;
          }
          const [editor] = yield* db
            .select({ creatorId: playlistEditors.creatorId })
            .from(playlistEditors)
            .where(
              and(
                eq(playlistEditors.playlistId, id),
                eq(playlistEditors.editorId, personId)
              )
            )
            .limit(1);
          if (!editor) {
            return yield* Effect.fail(missingPlaylist());
          }
          yield* mutuallyVisibleFriend(editor.creatorId);
          const [playlist] = yield* db
            .select({ collaborative: playlists.collaborative })
            .from(playlists)
            .where(
              and(
                eq(playlists.id, id),
                eq(playlists.creatorId, editor.creatorId)
              )
            )
            .limit(1);
          if (!playlist?.collaborative) {
            return yield* Effect.fail(missingPlaylist());
          }
          return editor.creatorId;
        }
      );
      const personSummary = (id: string) => {
        const { people } = readTrustRegistry(trustPath).store;
        const person = people.find((candidate) => candidate.id === id);
        return { id, username: person?.username ?? id };
      };
      const playlistGroup = HttpApiBuilder.group(
        OrbisApi,
        "playlists",
        (handlers) =>
          handlers
            .handle("list", () =>
              withFailureResponse(
                Effect.gen(function* listPersonalPlaylists() {
                  const personal = yield* Library;
                  return { playlists: yield* personal.playlists() };
                })
              )
            )
            .handle("shared", () =>
              withFailureResponse(
                Effect.gen(function* listSharedPlaylists() {
                  const caller = yield* SetCaller;
                  const rows = yield* db
                    .select({
                      createdAt: playlists.createdAt,
                      creatorId: playlists.creatorId,
                      id: playlists.id,
                      name: playlists.name,
                      setCount: sql<number>`(
                        SELECT COUNT(*)
                        FROM ${playlistSets}
                        WHERE ${playlistSets.playlistId} = ${playlists.id}
                      )`,
                    })
                    .from(playlistEditors)
                    .innerJoin(
                      playlists,
                      eq(playlists.id, playlistEditors.playlistId)
                    )
                    .where(
                      and(
                        eq(playlistEditors.editorId, caller.person.id),
                        eq(playlists.creatorId, playlistEditors.creatorId),
                        eq(playlists.collaborative, true)
                      )
                    )
                    .orderBy(asc(sql`${playlists.name} COLLATE NOCASE`));
                  const shared = [];
                  for (const { creatorId, ...playlist } of rows) {
                    const open = yield* Effect.option(
                      mutuallyVisibleFriend(creatorId)
                    );
                    if (Option.isSome(open)) {
                      shared.push({
                        ...playlist,
                        creator: personSummary(creatorId),
                      });
                    }
                  }
                  return { playlists: shared };
                })
              )
            )
            .handle("read", ({ params }) =>
              withFailureResponse(
                Effect.gen(function* readPlaylist() {
                  const caller = yield* SetCaller;
                  const ownerId = yield* editablePlaylistOwner(
                    params.id,
                    caller.person.id
                  );
                  const [playlist] = yield* db
                    .select({
                      createdAt: playlists.createdAt,
                      id: playlists.id,
                      name: playlists.name,
                    })
                    .from(playlists)
                    .where(eq(playlists.id, params.id))
                    .limit(1);
                  if (!playlist) {
                    return yield* Effect.fail(missingPlaylist());
                  }
                  const members = yield* Effect.provide(
                    Effect.gen(function* listPlaylistMembers() {
                      const ownerLibrary = yield* Library;
                      return yield* ownerLibrary.list({
                        playlistId: params.id,
                      });
                    }),
                    Library.forPersonLayer(ownerId, libraryOptions).pipe(
                      Layer.provide(Layer.succeed(Database, db))
                    )
                  );
                  const role: "creator" | "editor" =
                    ownerId === caller.person.id ? "creator" : "editor";
                  return {
                    ...playlist,
                    creator: personSummary(ownerId),
                    role,
                    setCount: members.length,
                    sets: members,
                  };
                })
              )
            )
            .handleRaw("create", () =>
              withFailureResponse(
                Effect.gen(function* createPlaylist() {
                  const input =
                    yield* HttpServerRequest.schemaBodyJson(
                      PlaylistNamePayload
                    );
                  const personal = yield* Library;
                  return yield* personal.createPlaylist(input.name);
                }).pipe(
                  Effect.tap(() => announceForCaller("playlist", seesPerson))
                )
              )
            )
            .handleRaw("import", () =>
              withFailureResponse(
                Effect.gen(function* importPlaylist() {
                  const input = yield* HttpServerRequest.schemaBodyJson(
                    ImportPlaylistPayload
                  );
                  const sourcePlaylistId = youTubePlaylistId(input.url);
                  if (!sourcePlaylistId) {
                    return yield* Effect.fail(
                      new LibraryError({
                        message:
                          "Use a YouTube or YouTube Music playlist link.",
                        statusCode: 400,
                      })
                    );
                  }
                  const caller = yield* SetCaller;
                  return yield* importer
                    .start({
                      personId: caller.person.id,
                      sourcePlaylistId,
                      url: input.url,
                    })
                    .pipe(
                      Effect.catchTag("MetadataError", (error) =>
                        Effect.fail(playlistImportRefusal(error))
                      )
                    );
                }).pipe(
                  Effect.tap(() => announceForCaller("playlist", seesPerson))
                )
              )
            )
            .handleRaw("importStatus", ({ params }) =>
              withFailureResponse(
                Effect.gen(function* readPlaylistImport() {
                  const caller = yield* SetCaller;
                  return yield* importer.read(caller.person.id, params.id);
                })
              )
            )
            .handleRaw("rename", ({ params }) =>
              withFailureResponse(
                Effect.gen(function* renamePlaylist() {
                  const input =
                    yield* HttpServerRequest.schemaBodyJson(
                      PlaylistNamePayload
                    );
                  const personal = yield* Library;
                  return yield* personal.renamePlaylist(params.id, input.name);
                }).pipe(
                  Effect.tap(() => announceForCaller("playlist", seesPerson))
                )
              )
            )
            .handle("remove", ({ params }) =>
              withFailureResponse(
                Effect.gen(function* removePersonalPlaylist() {
                  const personal = yield* Library;
                  return yield* personal.deletePlaylist(params.id);
                }).pipe(
                  Effect.tap(() => announceForCaller("playlist", seesPerson))
                )
              )
            )
            .handleRaw("replaceMembers", ({ params }) =>
              withFailureResponse(
                Effect.gen(function* replacePlaylistMembers() {
                  const input = yield* HttpServerRequest.schemaBodyJson(
                    PlaylistMembersPayload
                  );
                  const caller = yield* SetCaller;
                  const ownerId = yield* editablePlaylistOwner(
                    params.id,
                    caller.person.id
                  );
                  const personal = yield* Library;
                  if (ownerId !== caller.person.id) {
                    const visible = yield* personal.byIds(input.setIds);
                    if (visible.length !== input.setIds.length) {
                      return yield* Effect.fail(
                        new LibraryError({
                          message: "Set not found.",
                          statusCode: 404,
                        })
                      );
                    }
                    const ownerLayer = Library.forPersonLayer(
                      ownerId,
                      libraryOptions
                    ).pipe(Layer.provide(Layer.succeed(Database, db)));
                    const sets = yield* Effect.provide(
                      Effect.gen(function* updateSharedPlaylist() {
                        const ownerLibrary = yield* Library;
                        return yield* ownerLibrary.setPlaylistMembers(
                          params.id,
                          input.setIds
                        );
                      }),
                      ownerLayer
                    );
                    yield* announce("playlist", seesPerson(ownerId));
                    return { sets };
                  }
                  const sets = yield* personal.setPlaylistMembers(
                    params.id,
                    input.setIds
                  );
                  yield* announce("playlist", seesPerson(ownerId));
                  return { sets };
                })
              )
            )
            .handle("collaboration", ({ params }) =>
              withFailureResponse(
                Effect.gen(function* readPlaylistCollaboration() {
                  const caller = yield* SetCaller;
                  return yield* collaborationFor(params.id, caller.person.id);
                })
              )
            )
            .handleRaw("setCollaboration", ({ params }) =>
              withFailureResponse(
                Effect.gen(function* changePlaylistCollaboration() {
                  const caller = yield* SetCaller;
                  const input =
                    yield* HttpServerRequest.schemaBodyJson(
                      CollaborationPayload
                    );
                  yield* ownedPlaylist(params.id, caller.person.id);
                  yield* db
                    .update(playlists)
                    .set({ collaborative: input.collaborative })
                    .where(
                      and(
                        eq(playlists.id, params.id),
                        eq(playlists.creatorId, caller.person.id)
                      )
                    );
                  return yield* collaborationFor(params.id, caller.person.id);
                }).pipe(
                  Effect.tap(() => announceForCaller("playlist", seesPerson))
                )
              )
            )
            .handleRaw("setEditors", ({ params }) =>
              withFailureResponse(
                Effect.gen(function* setPlaylistEditors() {
                  const caller = yield* SetCaller;
                  const input = yield* HttpServerRequest.schemaBodyJson(
                    PlaylistEditorsPayload
                  );
                  yield* ownedPlaylist(params.id, caller.person.id);
                  if (
                    new Set(input.editorIds).size !== input.editorIds.length
                  ) {
                    return yield* Effect.fail(
                      new LibraryError({
                        message: "An editor can only appear once.",
                        statusCode: 400,
                      })
                    );
                  }
                  for (const editorId of input.editorIds) {
                    yield* mutuallyVisibleFriend(editorId);
                  }
                  yield* db.transaction((tx) =>
                    Effect.gen(function* replaceEditors() {
                      yield* tx
                        .delete(playlistEditors)
                        .where(eq(playlistEditors.playlistId, params.id));
                      const rows = input.editorIds.map((editorId) => ({
                        creatorId: caller.person.id,
                        editorId,
                        playlistId: params.id,
                      }));
                      for (const batch of insertBatches(
                        playlistEditors,
                        rows
                      )) {
                        yield* tx.insert(playlistEditors).values(batch);
                      }
                    })
                  );
                  return yield* collaborationFor(params.id, caller.person.id);
                }).pipe(
                  Effect.tap(() => announceForCaller("playlist", seesPerson))
                )
              )
            )
            .handleRaw("replaceSetPlaylists", ({ params }) =>
              withFailureResponse(
                Effect.gen(function* replaceSetPlaylists() {
                  const input =
                    yield* HttpServerRequest.schemaBodyJson(
                      SetPlaylistsPayload
                    );
                  const personal = yield* Library;
                  return yield* personal.setPlaylistMemberships(
                    params.id,
                    input.playlistIds
                  );
                }).pipe(
                  Effect.tap(() => announceForCaller("playlist", seesPerson))
                )
              )
            )
      );
      const queueGroup = HttpApiBuilder.group(OrbisApi, "queue", (handlers) =>
        handlers
          .handle("read", () =>
            withFailureResponse(
              Effect.gen(function* readPersonalQueue() {
                const queue = yield* Queue;
                return { queue: yield* queue.read() };
              })
            )
          )
          .handleRaw("play", () =>
            withFailureResponse(
              Effect.gen(function* setActiveQueueEntry() {
                const input =
                  yield* HttpServerRequest.schemaBodyJson(QueueSetPayload);
                const queue = yield* Queue;
                return { queue: yield* queue.play(input.setId) };
              }).pipe(
                Effect.tap(() =>
                  announceForCaller("listen-history", seesPerson)
                )
              )
            )
          )
          .handleRaw("insert", () =>
            Effect.map(
              withFailureResponse(
                Effect.gen(function* addQueueEntry() {
                  const input =
                    yield* HttpServerRequest.schemaBodyJson(QueueEntryPayload);
                  const queue = yield* Queue;
                  return {
                    queue: yield* queue.insert(input.setId, input.placement),
                  };
                })
              ),
              (result) =>
                HttpServerResponse.isHttpServerResponse(result)
                  ? result
                  : HttpServerResponse.jsonUnsafe(result, { status: 201 })
            )
          )
          .handleRaw("replaceWithPlaylist", () =>
            withFailureResponse(
              Effect.gen(function* replaceQueueFromPlaylist() {
                const input =
                  yield* HttpServerRequest.schemaBodyJson(QueuePlaylistPayload);
                const caller = yield* SetCaller;
                const creatorId = yield* editablePlaylistOwner(
                  input.playlistId,
                  caller.person.id
                );
                const queue = yield* Queue;
                return {
                  queue: yield* queue.replaceWithPlaylist(
                    input.playlistId,
                    creatorId
                  ),
                };
              }).pipe(
                Effect.tap(() =>
                  announceForCaller("listen-history", seesPerson)
                )
              )
            )
          )
          .handleRaw("complete", () =>
            withFailureResponse(
              Effect.gen(function* completeQueueEntry() {
                const input =
                  yield* HttpServerRequest.schemaBodyJson(QueueSetPayload);
                const queue = yield* Queue;
                return { queue: yield* queue.complete(input.setId) };
              }).pipe(
                Effect.tap(() =>
                  announceForCaller("listen-history", seesPerson)
                )
              )
            )
          )
      );
      const appleMusicGroup = HttpApiBuilder.group(
        OrbisApi,
        "appleMusic",
        (handlers) =>
          handlers.handle("search", ({ query }) =>
            withFailureResponse(
              Effect.gen(function* searchAppleMusic() {
                const words = query.q.trim().replaceAll(/\s+/gu, " ");
                if (!words) {
                  return yield* Effect.fail(
                    new LibraryError({
                      message: "Type what to find on Apple Music.",
                      statusCode: 400,
                    })
                  );
                }
                const found = yield* metadata
                  .searchAppleMusic(words)
                  .pipe(
                    Effect.catchTag("MetadataError", (error) =>
                      Effect.fail(appleMusicSearchRefusal(error))
                    )
                  );
                const personal = yield* Library;
                const saved = yield* personal.savedUrls(
                  found.map((album) => album.url)
                );
                return {
                  albums: found.map((album) => ({
                    ...album,
                    inLibrary: saved.has(album.url),
                  })),
                };
              })
            )
          )
      );
      const libraryGroup = HttpApiBuilder.group(
        OrbisApi,
        "library",
        (handlers) =>
          handlers
            .handleRaw("setPosition", ({ params }) =>
              withFailureResponse(
                Effect.gen(function* setPlaybackPosition() {
                  const input =
                    yield* HttpServerRequest.schemaBodyJson(PositionPayload);
                  const caller = yield* SetCaller;
                  const personal = yield* Library;
                  const saved = yield* personal.setPlaybackPosition(
                    params.id,
                    input.seconds
                  );
                  if (caller.keyId !== null) {
                    yield* presence.recordLegacyReport(
                      { keyId: caller.keyId, personId: caller.person.id },
                      params.id
                    );
                  }
                  return saved;
                })
              )
            )
            .handle("tags", () =>
              withFailureResponse(
                Effect.gen(function* listPersonalTags() {
                  const personal = yield* Library;
                  return { tags: yield* personal.tags() };
                })
              )
            )
            .handleRaw("updateTags", ({ params }) =>
              withFailureResponse(
                Effect.gen(function* updateTags() {
                  const input =
                    yield* HttpServerRequest.schemaBodyJson(TagsPayload);
                  const personal = yield* Library;
                  return yield* personal.updateTags(params.id, input.tags);
                }).pipe(
                  Effect.tap(() => announceForCaller("library", ownDevices))
                )
              )
            )
      );
      const friendLibraryLayer = (personId: string) =>
        Library.forPersonLayer(personId).pipe(
          Layer.provide(Layer.succeed(Database, db))
        );
      const presenceFor = Effect.fn("App.presenceFor")(function* readPresence(
        viewerId: string
      ) {
        const { people } = readTrustRegistry(trustPath).store;
        const now = presenceNow();
        const found = [];
        for (const person of people) {
          let target;
          try {
            target = resolveVisiblePerson(people, viewerId, person.id);
          } catch {
            continue;
          }
          const setId = yield* presence
            .currentSetFor(target.id, now)
            .pipe(Effect.orElseSucceed(() => null));
          if (setId === null) {
            continue;
          }
          const [set] = yield* Effect.provide(
            Effect.gen(function* hydratePresence() {
              const personal = yield* Library;
              return yield* personal.byIds([setId]);
            }),
            friendLibraryLayer(target.id)
          ).pipe(Effect.orElseSucceed(() => []));
          if (set) {
            found.push({
              personId: target.id,
              set,
              username: target.username,
            });
          }
        }
        return found;
      });
      const peopleGroup = HttpApiBuilder.group(OrbisApi, "people", (handlers) =>
        handlers
          .handle("me", () =>
            Effect.gen(function* readMe() {
              const { person } = yield* SetCaller;
              return meBody(person);
            })
          )
          .handleRaw("updateMe", () =>
            withFailureResponse(
              Effect.gen(function* updateMe() {
                const caller = yield* SetCaller;
                const input =
                  yield* HttpServerRequest.schemaBodyJson(UpdateMePayload);
                const result = yield* trustOperation(() =>
                  updatePerson(trustPath, caller.person.id, input)
                ).pipe(Effect.mapError(trustUnavailable));
                if (result.kind === "updated") {
                  return HttpServerResponse.jsonUnsafe(meBody(result.person));
                }
                let statusCode = 500;
                let message = "The trust store is unavailable.";
                if (result.kind === "invalid") {
                  statusCode = 400;
                  message = "Choose a username with 1 to 40 characters.";
                } else if (result.kind === "conflict") {
                  statusCode = 409;
                  message = "That username is already in use.";
                }
                return yield* new LibraryError({ message, statusCode });
              })
            )
          )
          .handleRaw("list", () =>
            withFailureResponse(
              Effect.gen(function* listVisiblePeople() {
                const caller = yield* SetCaller;
                const { people } = readTrustRegistry(trustPath).store;
                return {
                  people: people.flatMap((person) => {
                    try {
                      const visible = resolveVisiblePerson(
                        people,
                        caller.person.id,
                        person.id
                      );
                      return [{ id: visible.id, username: visible.username }];
                    } catch {
                      return [];
                    }
                  }),
                };
              })
            )
          )
          .handleRaw("socialFilters", () =>
            withFailureResponse(
              Effect.gen(function* listSocialFilters() {
                const caller = yield* SetCaller;
                const { people } = readTrustRegistry(trustPath).store;
                return {
                  people: listFilterablePeople(people, caller.person.id),
                };
              })
            )
          )
          .handleRaw("filters", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* setSocialFilters() {
                const caller = yield* SetCaller;
                const input =
                  yield* HttpServerRequest.schemaBodyJson(SocialFiltersPayload);
                const result = yield* trustOperation(() =>
                  updatePersonFilters(
                    trustPath,
                    caller.person.id,
                    params.id,
                    input
                  )
                ).pipe(Effect.mapError(trustUnavailable));
                if (result.kind === "updated") {
                  return { appear: result.appear, see: result.see };
                }
                return yield* new LibraryError({
                  message:
                    result.kind === "invalid"
                      ? "Choose at least one filter."
                      : "Person not found.",
                  statusCode: { invalid: 400, missing: 404, unavailable: 500 }[
                    result.kind
                  ],
                });
              })
            )
          )
          .handleRaw("sets", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* readFriendLibrary() {
                const target = yield* visibleFriend(params.id);
                const sets = yield* Effect.provide(
                  Effect.gen(function* listFriendSets() {
                    const personal = yield* Library;
                    return yield* personal.list({});
                  }),
                  friendLibraryLayer(target.id)
                );
                return { sets };
              })
            )
          )
          .handleRaw("friendPlaylists", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* readFriendPlaylists() {
                const target = yield* visibleFriend(params.id);
                const friendPlaylists = yield* Effect.provide(
                  Effect.gen(function* listFriendPlaylists() {
                    const personal = yield* Library;
                    const owned = yield* personal.playlists();
                    // eslint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach is not Array.forEach.
                    return yield* Effect.forEach(owned, (playlist) =>
                      Effect.map(
                        personal.list({ playlistId: playlist.id }),
                        (sets) => ({
                          ...playlist,
                          sets,
                        })
                      )
                    );
                  }),
                  friendLibraryLayer(target.id)
                );
                return { playlists: friendPlaylists };
              })
            )
          )
          .handleRaw("friendListens", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* readFriendListens() {
                const target = yield* visibleFriend(params.id);
                const rows = yield* db
                  .select({
                    finishedAt: listens.finishedAt,
                    id: listens.id,
                    setId: listens.setId,
                    startedAt: listens.startedAt,
                  })
                  .from(listens)
                  .where(eq(listens.personId, target.id))
                  .orderBy(desc(listens.startedAt), desc(listens.id));
                const history = yield* Effect.provide(
                  Effect.gen(function* hydrateFriendListens() {
                    const personal = yield* Library;
                    const sets = yield* personal.byIds(
                      rows.map((row) => row.setId)
                    );
                    const byId = new Map(sets.map((set) => [set.id, set]));
                    return rows.flatMap((row) => {
                      const set = byId.get(row.setId);
                      return set
                        ? [
                            {
                              finishedAt: row.finishedAt,
                              set,
                              startedAt: row.startedAt,
                            },
                          ]
                        : [];
                    });
                  }),
                  friendLibraryLayer(target.id)
                );
                return { listens: history };
              })
            )
          )
      );
      const requireHost = Effect.gen(function* verifyHost() {
        const caller = yield* SetCaller;
        if (caller.keyId === null || caller.person.id !== HOST_PERSON_ID) {
          return yield* new LibraryError({
            message: "Only the Host can do this.",
            statusCode: 403,
          });
        }
      });
      const trustCall = <A>(action: (storePath: string) => A) =>
        trustOperation(() => {
          if (!trustPath) {
            throw new AdminError(500, "The trust store is unavailable.");
          }
          return action(trustPath);
        }).pipe(Effect.mapError(({ cause }) => fromAdminError(cause)));
      const adminCall = <A>(action: (storePath: string) => A) =>
        Effect.andThen(requireHost, trustCall(action));
      const issueCodeFor = (personId: string) =>
        Effect.map(
          trustCall((storePath) =>
            issueSignInCode(storePath, personId, signInCodeNow())
          ),
          (issued) => HttpServerResponse.jsonUnsafe(issued, { status: 201 })
        );
      // Devices act for the Person behind a key. A stream grant has no key, so
      // it is refused.
      const deviceCall = Effect.fn("App.deviceCall")(
        function* authorizedDeviceAction<A>(
          action: (storePath: string, personId: string, keyId: string) => A
        ) {
          const caller = yield* SetCaller;
          const { keyId } = caller;
          if (keyId === null) {
            return yield* new LibraryError({
              message: "Sign in with a device key.",
              statusCode: 403,
            });
          }
          return yield* trustCall((storePath) =>
            action(storePath, caller.person.id, keyId)
          );
        }
      );
      // An unknown code or secret counts as a failed sign-in attempt, and the
      // attempt that takes a client over the limit already answers 429.
      const failedApproval = (client: string, message: string) =>
        attempts.signInAttempt(client)
          ? tooManyAttemptsFailure()
          : new LibraryError({ message, statusCode: 404 });
      // Only a signed-in device approves, and a client or Group over the
      // failed-attempt limit is refused before the lookup, so it cannot learn
      // that a guess was right.
      const approverCall = Effect.fn("App.approverCall")(
        function* approverAction(
          action: (
            code: string,
            personId: string
          ) => ReturnType<typeof approvals.find>
        ) {
          const caller = yield* SetCaller;
          if (caller.keyId === null) {
            return yield* new LibraryError({
              message: "Sign in with a device key.",
              statusCode: 403,
            });
          }
          const client = yield* ClientAddress;
          if (attempts.refusing(client)) {
            return yield* tooManyAttemptsFailure();
          }
          const input =
            yield* HttpServerRequest.schemaBodyJson(ApprovalCodePayload);
          const found = action(input.code, caller.person.id);
          if (found === null) {
            return yield* failedApproval(
              client,
              "No device is waiting with that code."
            );
          }
          return HttpServerResponse.jsonUnsafe(found);
        }
      );
      // The key is already gone, so a failed clear is logged: the next settle sweeps the
      // rows and the lease bounds how long the stale Presence can show.
      const clearRevokedPresence = (keyId: string) =>
        presence.revokeKey(keyId).pipe(
          Effect.catchTag("LibraryError", (failure) =>
            Effect.logWarning("revoked key presence not cleared").pipe(
              Effect.annotateLogs({ cause: failure.message })
            )
          ),
          Effect.andThen(recheckAccess())
        );
      const devicesGroup = HttpApiBuilder.group(
        OrbisApi,
        "devices",
        (handlers) =>
          handlers
            .handleRaw("list", () =>
              withFailureResponse(
                Effect.map(deviceCall(listDevices), (devices) => ({ devices }))
              )
            )
            .handleRaw("revoke", ({ params }) =>
              withFailureResponse(
                deviceCall((storePath, personId, keyId) =>
                  revokeDevice(storePath, personId, keyId, params.id)
                ).pipe(Effect.tap(() => clearRevokedPresence(params.id)))
              )
            )
            .handleRaw("signInCode", () =>
              withFailureResponse(
                Effect.gen(function* issueOwnSignInCode() {
                  const { person } = yield* SetCaller;
                  return yield* issueCodeFor(person.id);
                })
              )
            )
            .handleRaw("findSignInRequest", () =>
              withFailureResponse(approverCall(approvals.find))
            )
            .handleRaw("approveSignInRequest", () =>
              withFailureResponse(approverCall(approvals.approve))
            )
      );
      const adminGroup = HttpApiBuilder.group(OrbisApi, "admin", (handlers) =>
        handlers
          .handleRaw("people", () =>
            withFailureResponse(
              Effect.map(adminCall(listPeople), (people) => ({ people }))
            )
          )
          .handleRaw("addPerson", () =>
            withFailureResponse(
              Effect.gen(function* addAdminPerson() {
                yield* requireHost;
                const input =
                  yield* HttpServerRequest.schemaBodyJson(AdminPersonPayload);
                const person = yield* adminCall((storePath) =>
                  addPerson(storePath, input.username)
                );
                return HttpServerResponse.jsonUnsafe(person, { status: 201 });
              })
            )
          )
          .handleRaw("removePerson", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* removeAdminPerson() {
                const person = yield* adminCall((storePath) =>
                  removePerson(storePath, params.id)
                );
                const released = yield* db
                  .all<{ readonly id: string }>(sql`
                  SELECT set_id AS id FROM library_entries WHERE person_id = ${params.id}
                  UNION SELECT set_id AS id FROM queue_entries WHERE person_id = ${params.id}
                  UNION SELECT set_id AS id FROM playlist_sets INNER JOIN playlists ON playlists.id = playlist_sets.playlist_id WHERE creator_id = ${params.id}
                `)
                  .pipe(asLibraryError("Could not remove the Person's data."));
                yield* db
                  .transaction((tx) =>
                    Effect.gen(function* deleteAdminPersonRows() {
                      yield* tx.run(
                        sql`DELETE FROM playlist_sets WHERE playlist_id IN (SELECT id FROM playlists WHERE creator_id = ${params.id})`
                      );
                      yield* tx.run(
                        sql`DELETE FROM playlists WHERE creator_id = ${params.id}`
                      );
                      yield* tx.run(
                        sql`DELETE FROM queue_entries WHERE person_id = ${params.id}`
                      );
                      yield* tx.run(
                        sql`DELETE FROM playback_positions WHERE person_id = ${params.id}`
                      );
                      yield* tx.run(
                        sql`DELETE FROM listens WHERE person_id = ${params.id}`
                      );
                      yield* tx.run(
                        sql`DELETE FROM library_entries WHERE person_id = ${params.id}`
                      );
                      yield* tx.run(
                        sql`UPDATE sets SET download_state = 'none'
                          WHERE download_state IN ('queued', 'downloading')
                          AND id IN (SELECT set_id FROM download_jobs WHERE person_id = ${params.id})`
                      );
                      yield* tx.run(
                        sql`DELETE FROM download_jobs WHERE person_id = ${params.id}`
                      );
                      yield* tx.run(
                        sql`DELETE FROM download_requesters WHERE person_id = ${params.id}`
                      );
                      yield* presence.removePerson(tx, params.id);
                    })
                  )
                  .pipe(
                    Effect.mapError(
                      () =>
                        new LibraryError({
                          message: "Could not remove the Person's data.",
                          statusCode: 500,
                        })
                    )
                  );
                yield* presence.afterCommit();
                yield* recheckAccess();
                yield* Effect.forEach((set: { readonly id: string }) =>
                  library.release(set.id)
                )(released);
                return person;
              })
            )
          )
          .handleRaw("keys", () =>
            withFailureResponse(
              Effect.map(
                adminCall((storePath) => listKeys(storePath)),
                (keys) => ({ keys })
              )
            )
          )
          .handleRaw("personKeys", ({ params }) =>
            withFailureResponse(
              Effect.map(
                adminCall((storePath) => listKeys(storePath, params.id)),
                (keys) => ({ keys })
              )
            )
          )
          .handleRaw("addKey", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* addAdminKey() {
                yield* requireHost;
                const input =
                  yield* HttpServerRequest.schemaBodyJson(AdminKeyPayload);
                const key = yield* adminCall((storePath) =>
                  addKey(storePath, params.id, input)
                );
                return HttpServerResponse.jsonUnsafe(key, { status: 201 });
              })
            )
          )
          .handleRaw("revokeKey", ({ params }) =>
            withFailureResponse(
              adminCall((storePath) => revokeKey(storePath, params.id)).pipe(
                Effect.tap(() => clearRevokedPresence(params.id))
              )
            )
          )
          .handleRaw("signInCodeFor", ({ params }) =>
            withFailureResponse(
              Effect.andThen(requireHost, issueCodeFor(params.id))
            )
          )
          .handleRaw("passcode", () =>
            withFailureResponse(adminCall(readPasscode))
          )
          .handleRaw("newPasscode", () =>
            withFailureResponse(adminCall(newPasscode))
          )
          .handleRaw("closeJoining", () =>
            withFailureResponse(adminCall(closeJoining))
          )
      );
      const signInGroup = HttpApiBuilder.group(OrbisApi, "signIn", (handlers) =>
        handlers
          .handleRaw("redeem", () =>
            withFailureResponse(
              Effect.gen(function* redeemCode() {
                const input = yield* HttpServerRequest.schemaBodyJson(
                  RedeemSignInCodePayload
                );
                const signedIn = yield* trustCall((storePath) =>
                  redeemSignInCode(storePath, input, signInCodeNow())
                );
                if (signedIn === null) {
                  return yield* invalidSignInCode();
                }
                return HttpServerResponse.jsonUnsafe(signedIn);
              })
            )
          )
          .handleRaw("join", () =>
            withFailureResponse(
              Effect.gen(function* joinWithPasscode() {
                const input =
                  yield* HttpServerRequest.schemaBodyJson(JoinPayload);
                const joined = yield* trustCall((storePath) =>
                  joinGroup(storePath, input)
                );
                return HttpServerResponse.jsonUnsafe(joined, { status: 201 });
              })
            )
          )
          .handleRaw("startRequest", () =>
            withFailureResponse(
              Effect.gen(function* startApprovalRequest() {
                const input = yield* HttpServerRequest.schemaBodyJson(
                  StartApprovalRequestPayload
                );
                const client = yield* ClientAddress;
                const started = yield* Effect.try({
                  catch: fromAdminError,
                  try: () => approvals.start(input, client),
                });
                return uncached(started, 201);
              })
            )
          )
          .handleRaw("waitRequest", () =>
            withFailureResponse(
              Effect.gen(function* waitForApproval() {
                const { secret } = yield* HttpServerRequest.schemaBodyJson(
                  WaitApprovalRequestPayload
                );
                const watched = approvals.watch(secret);
                if (watched === null) {
                  return yield* failedApproval(
                    yield* ClientAddress,
                    EXPIRED_APPROVAL
                  );
                }
                yield* Deferred.await(watched.approved).pipe(
                  Effect.timeoutOption(Math.min(approvalWaitMs, watched.msLeft))
                );
                const outcome = approvals.collect(secret);
                if (outcome === null) {
                  return yield* expiredApproval();
                }
                if (outcome.status === "pending") {
                  return uncached({ status: "pending" });
                }
                const signedIn = yield* trustCall((storePath) =>
                  collectApprovalKey(storePath, outcome.personId, outcome.label)
                );
                if (signedIn === null) {
                  return yield* expiredApproval();
                }
                return uncached({ status: "approved", ...signedIn });
              })
            )
          )
      );
      const eventsGroup = HttpApiBuilder.group(OrbisApi, "events", (handlers) =>
        handlers.handle("subscribe", ({ query }) =>
          Effect.gen(function* subscribeEvents() {
            const queue = yield* Queue;
            const caller = yield* SetCaller;
            const authorized = () => {
              if (caller.keyId === null) {
                return true;
              }
              const { store } = readTrustRegistry(trustPath);
              return (
                store.keys.some(
                  (key) =>
                    key.id === caller.keyId && key.personId === caller.person.id
                ) &&
                store.people.some(
                  (person) => person.id === caller.person.id && !person.removed
                )
              );
            };
            const snapshots = queue.changes.pipe(
              Stream.mapEffect(() => queue.read()),
              Stream.map((snapshot) => ({
                kind: "queue" as const,
                queue: snapshot,
              }))
            );
            const presenceFrames = Stream.merge(
              Stream.tick("2 seconds"),
              presence.changes
            ).pipe(
              Stream.mapEffect(() => presenceFor(caller.person.id)),
              Stream.changesWith(
                (left, right) => JSON.stringify(left) === JSON.stringify(right)
              ),
              Stream.map((found) => ({
                kind: "presence" as const,
                presence: found,
              }))
            );
            const heartbeats = Stream.tick("30 seconds").pipe(
              Stream.drop(1),
              Stream.map(() => ({ kind: "heartbeat" as const }))
            );
            // A null entry only makes `authorized` run, so a revoked key closes at once.
            const changeFrames = Stream.fromPubSub(changes).pipe(
              Stream.mapEffect((change): Effect.Effect<ChangeFrame> => {
                if (query.changes !== "1") {
                  return Effect.succeed(null);
                }
                if (change.kind === "changed") {
                  return Effect.map(
                    change.reaches(caller.person.id),
                    (reached) =>
                      reached
                        ? { kind: "changed" as const, topic: change.topic }
                        : null
                  );
                }
                return Effect.succeed(
                  change.kind === "playlistImport" &&
                    change.personId === caller.person.id
                    ? {
                        kind: "playlistImport" as const,
                        playlistImport: change.playlistImport,
                      }
                    : null
                );
              })
            );
            return Stream.merge(
              Stream.merge(snapshots, presenceFrames),
              Stream.merge(heartbeats, changeFrames)
            ).pipe(
              Stream.takeWhile(authorized),
              Stream.filter((frame) => frame !== null),
              Stream.orDie
            );
          })
        )
      );
      const presenceGroup = HttpApiBuilder.group(
        OrbisApi,
        "presence",
        (handlers) =>
          handlers.handleRaw("act", () =>
            withFailureResponse(
              Effect.gen(function* actOnPresence() {
                const caller = yield* SetCaller;
                const { keyId } = caller;
                if (keyId === null) {
                  return yield* new LibraryError({
                    message: "Sign in with a device key.",
                    statusCode: 403,
                  });
                }
                const input = yield* HttpServerRequest.schemaBodyJson(
                  PresenceActionPayload
                );
                if (input.kind === "play") {
                  const personal = yield* Library;
                  const [set] = yield* personal.byIds([input.setId]);
                  if (!set) {
                    return yield* new LibraryError({
                      message: "Set not found.",
                      statusCode: 404,
                    });
                  }
                }
                return yield* presence
                  .act({ keyId, personId: caller.person.id }, input)
                  .pipe(
                    Effect.catchTag("PresenceConflict", (refusal) =>
                      Effect.succeed(
                        HttpServerResponse.jsonUnsafe(
                          { message: refusal.message, reason: refusal.reason },
                          { status: 409 }
                        )
                      )
                    )
                  );
              })
            )
          )
      );
      const diagnosticsGroup = HttpApiBuilder.group(
        OrbisApi,
        "diagnostics",
        (handlers) =>
          handlers.handleRaw("playback", ({ request }) =>
            withFailureResponse(
              Effect.gen(function* playbackDiagnostics() {
                const caller = yield* SetCaller;
                if (caller.keyId === null) {
                  return HttpServerResponse.jsonUnsafe(
                    { message: "A device key is required." },
                    { status: 403 }
                  );
                }
                const web = yield* HttpServerRequest.toWeb(request);
                const body = yield* Effect.tryPromise({
                  catch: (error) =>
                    new LibraryError({
                      message:
                        error instanceof PlaybackBodyLimitError
                          ? "Playback batch exceeds 64 KiB."
                          : "Invalid playback batch.",
                      statusCode:
                        error instanceof PlaybackBodyLimitError ? 413 : 400,
                    }),
                  try: (signal) => readBoundedBody(web.body, 65_536, signal),
                });
                const batch = yield* Effect.try(() =>
                  decodePlaybackDiagnosticsBatch(JSON.parse(body))
                );
                const response = yield* Effect.tryPromise((signal) =>
                  relayPlayback(batch, signal)
                );
                return HttpServerResponse.fromWeb(response);
              })
            )
          )
      );
      const systemGroup = HttpApiBuilder.group(OrbisApi, "system", (handlers) =>
        handlers.handle("health", () =>
          Effect.succeed({ status: "ok" as const })
        )
      );
      yield* Layer.buildWithScope(
        HttpApiBuilder.layer(OrbisApi, { openapiPath: "/openapi.json" }).pipe(
          Layer.provide(setGroup),
          Layer.provide(appleMusicGroup),
          Layer.provide(playlistGroup),
          Layer.provide(queueGroup),
          Layer.provide(libraryGroup),
          Layer.provide(systemGroup),
          Layer.provide(diagnosticsGroup),
          Layer.provide(signInGroup),
          Layer.provide(eventsGroup),
          Layer.provide(presenceGroup),
          Layer.provide(peopleGroup),
          Layer.provide(adminGroup),
          Layer.provide(devicesGroup),
          Layer.provide(
            Layer.succeed(SetAccess, {
              bearer: (effect) =>
                Effect.flatMap(
                  Effect.withFiberSucceed((fiber) =>
                    Context.getOption(fiber.context, AcceptedAccess)
                  ),
                  Option.match({
                    onNone: () => Effect.die("Accepted access context missing"),
                    onSome: (access) => {
                      const personalLibrary = Library.forPersonLayer(
                        access.person.id,
                        libraryOptions
                      ).pipe(Layer.provide(Layer.succeed(Database, db)));
                      const personalQueue = Queue.forPersonLayer(
                        access.person.id
                      ).pipe(
                        Layer.provide(
                          Layer.mergeAll(
                            Layer.succeed(Database, db),
                            Layer.succeed(QueueSignals, signals),
                            Layer.succeed(Presence, presence),
                            personalLibrary,
                            Stats.forPersonLayer(access.person.id).pipe(
                              Layer.provide(Layer.succeed(Database, db))
                            )
                          )
                        )
                      );
                      return Effect.provide(
                        Effect.provideService(
                          Effect.gen(function* callerRequest() {
                            const request =
                              yield* HttpServerRequest.HttpServerRequest;
                            if (
                              request.headers["x-orbis-ingress"] ===
                              "funnel-forward"
                            ) {
                              const key = readTrustRegistry(
                                trustPath
                              ).store.keys.find(
                                (record) => record.id === access.keyId
                              );
                              yield* annotateForwardedRequest(
                                key?.label ?? null
                              );
                            }
                            return yield* effect;
                          }),
                          SetCaller,
                          access
                        ),
                        Layer.mergeAll(personalLibrary, personalQueue)
                      );
                    },
                  })
                ),
            })
          ),
          Layer.provide(HttpServer.layerServices)
        ),
        scope
      );
    })
  );
  const app = HttpRouter.toWebHandler(
    routes.pipe(
      Layer.provide(options.audio),
      Layer.provide(libraryLayer),
      Layer.provide(presenceLayer),
      Layer.provide(queueSignalsLayer),
      Layer.provide(options.metadata ?? Metadata.unconfigured()),
      Layer.provide(options.titleReviser ?? TitleReviser.unconfigured()),
      Layer.provide(options.versos ?? Versos.unconfigured()),
      Layer.provide(database),
      Layer.provide(loggingLayer)
    ),
    {
      disableLogger: true,
      middleware: makeRequestLogMiddleware(options.logging),
    }
  );
  /**
   * A sign-in attempt counts toward the failed-key limit before it runs. A
   * client over the limit is refused before any lookup, so it cannot spend a
   * code.
   */
  const openRoute = (
    request: Request,
    client: string,
    counting: "counted" | "counts-failures"
  ): Promise<Response> => {
    if (counting === "counted" && attempts.signInAttempt(client)) {
      return Promise.resolve(tooManyAttempts());
    }
    // SAFETY: the sign-in handlers read no caller-bound service.
    return app.handler(
      request,
      Context.make(ClientAddress, client) as Context.Context<
        Library | Queue | ClientAddress
      >
    );
  };
  const initialize = () =>
    // SAFETY: The health route reads no caller-bound service.
    app.handler(
      new Request("http://orbis.internal/health"),
      Context.empty() as Context.Context<Library | Queue | ClientAddress>
    );
  // oxlint-disable-next-line eslint/sort-keys -- Lifecycle methods precede the request boundary.
  return {
    dispose: app.dispose,
    initialize,
    expirePresence: async (): Promise<void> => {
      await initialize();
      if (presenceService) {
        await Effect.runPromise(presenceService.expire(presenceNow()));
      }
    },
    resumeImports: async (): Promise<void> => {
      await initialize();
      if (importerService) {
        await Effect.runPromise(importerService.resume());
      }
    },
    handler: async (
      request: Request,
      mode: AccessMode,
      clientAddress = "unknown"
    ): Promise<Response> => {
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- Kept at the boundary that owns stream headers.
      const withOrigin = (response: Response): Response => {
        if (
          response.headers.get("content-type")?.startsWith("text/event-stream")
        ) {
          response.headers.set("cache-control", "no-cache, no-transform");
          response.headers.set("x-accel-buffering", "no");
        }
        return response;
      };
      const host = request.headers.get("host") ?? new URL(request.url).host;
      const authorization = request.headers.get("authorization");
      const open =
        request.method === "POST"
          ? OPEN_ROUTES.get(routePath(request.url))
          : undefined;
      if (open) {
        return openRoute(request, clientAddress, open);
      }
      const registry = readTrustRegistry(trustPath);
      const logRefusal = (status: number, fields: LoggedRecord) => {
        const logger = startRequestLog({
          method: request.method,
          path: safeRequestPath(request.url),
          requestId: crypto.randomUUID(),
        });
        logger.set(fields);
        finishRequestLog(
          logger,
          { outcome: "rejected", status },
          options.logging
        );
      };
      const streamAccess = grantAccess(
        request,
        mode,
        registry.store,
        streamSecret
      );
      if (rejectedStreamGrant(request, streamAccess)) {
        logRefusal(401, {
          audio: {
            grant: streamAccess?.grant ?? "unchecked",
            reason: "grant-refused",
            result: "refused",
            set: streamAccess?.set ?? null,
          },
        });
        return withOrigin(
          Response.json({ message: "Invalid stream grant." }, { status: 401 })
        );
      }
      const decision =
        streamAccess?.decision ??
        decideAccess({
          authorization,
          hasOrigin: false,
          host,
          mode,
          store: registry.store,
        });
      if (
        mode === "device" &&
        authorization !== null &&
        decision.kind === "rejected" &&
        decision.statusCode === 401 &&
        attempts.badKey(clientAddress)
      ) {
        return withOrigin(tooManyAttempts());
      }
      if (decision.kind === "rejected") {
        const refusal = refusalFor(request, decision);
        // A damaged trust store refuses every device. Without `trustStore` the
        // only visible symptom is a sudden run of 401 responses.
        logRefusal(refusal.statusCode, {
          reason: refusal.message,
          trustStore: registry.storeError,
        });
        return withOrigin(
          Response.json(
            { message: refusal.message },
            { status: refusal.statusCode }
          )
        );
      }
      if (options.recordKeyUse !== false) {
        await Effect.runPromise(
          trustOperation(() => markKeyUsed(trustPath, decision.keyId)).pipe(
            Effect.ignore
          )
        );
      }
      // SAFETY: SetAccess provides the caller-bound Library and Queue before handlers read them.
      const response = await app.handler(
        request,
        Context.make(SetCaller, decision).pipe(
          Context.add(AcceptedAccess, decision),
          Context.add(ClientAddress, clientAddress)
        ) as Context.Context<Library | Queue | SetCaller | ClientAddress>
      );
      return withOrigin(
        forwardedResponse(request, response, registry.store, decision.keyId)
      );
    },
  };
};
