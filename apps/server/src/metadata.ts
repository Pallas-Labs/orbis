import type { SetSource } from "@orbis/contracts";
import { Context, Effect, Layer, Option, Schema } from "effect";

import { MAX_SETS_PER_PLAYLIST } from "./library-limits.js";
import { MetadataError } from "./metadata-error.js";
import { youTubeVideoId } from "./source-url.js";
import type { SourceDetails, YtDlpMetadataService } from "./ytdlp-metadata.js";

/** What only yt-dlp reports. Absent when yt-dlp is not configured or could not read the link. */
export type SourceExtras = Pick<
  SourceDetails,
  "chapters" | "creatorId" | "creatorUrl" | "description" | "genre" | "tags"
>;

export interface EnrichedMetadata {
  readonly artworkUrl: string | null;
  readonly artworkLargeUrl: string | null;
  readonly creator: string | null;
  readonly durationSeconds: number | null;
  readonly extras?: SourceExtras;
  readonly releasedAt: string | null;
  readonly title: string;
}

export interface EnrichInput {
  readonly source: SetSource;
  readonly url: string;
}

/** One playable track of a YouTube playlist, read with the same fields a single save reads. */
export interface PlaylistTrack {
  readonly metadata: EnrichedMetadata;
  readonly url: string;
}

export interface YouTubePlaylist {
  /** Tracks past the Playlist maximum, which were not read. */
  readonly overLimit: number;
  readonly title: string;
  /** In the playlist's order, each video once. */
  readonly tracks: readonly PlaylistTrack[];
  /** Entries YouTube lists but no longer serves: deleted, private, or blocked. */
  readonly unavailable: number;
}

export interface MetadataService {
  readonly enrich: (
    input: EnrichInput
  ) => Effect.Effect<EnrichedMetadata, MetadataError>;
  /** The slow read a Set gets after it is saved: what only yt-dlp reports, plus any gaps. */
  readonly details: (
    input: EnrichInput
  ) => Effect.Effect<SourceDetails, MetadataError>;
  /** The tracks of a public or unlisted YouTube playlist, read from the Data API. */
  readonly playlist: (
    playlistId: string
  ) => Effect.Effect<YouTubePlaylist, MetadataError>;
}

export interface MetadataOptions {
  readonly fetch?: RequestFetch;
  /** Fills what the provider APIs leave out, and stands in for a YouTube API key that is not set. */
  readonly ytDlp?: YtDlpMetadataService | undefined;
  readonly youTubeApiKey?: string | undefined;
}

type RequestFetch = (url: string, signal: AbortSignal) => Promise<Response>;

interface Provider {
  readonly enrich: (
    url: string
  ) => Effect.Effect<EnrichedMetadata, MetadataError>;
}

interface ProviderOptions {
  readonly label: string;
  readonly request: RequestFetch;
}

const PROVIDER_TIMEOUT = "5 seconds";

const notConfigured = (message: string) =>
  new MetadataError({ message, reason: "not-configured" });
const rejected = (message: string) =>
  new MetadataError({ message, reason: "provider-rejected" });
const unavailable = (message: string) =>
  new MetadataError({ message, reason: "provider-unavailable" });
const unexpected = (message: string) =>
  new MetadataError({ message, reason: "unexpected-response" });
const unsupported = (message: string) =>
  new MetadataError({ message, reason: "unsupported-source" });

const ISO_DURATION =
  /^P(?:(?<days>\d+)D)?(?:T(?:(?<hours>\d+)H)?(?:(?<minutes>\d+)M)?(?:(?<seconds>\d+)S)?)?$/u;
const HAS_DIGIT = /\d/u;

const unitSeconds = (value: string | undefined, scale: number) =>
  value ? Number(value) * scale : 0;

const parseDurationSeconds = (duration: string): number | null => {
  const groups = ISO_DURATION.exec(duration)?.groups;
  if (!(groups && HAS_DIGIT.test(duration))) {
    return null;
  }
  return (
    unitSeconds(groups.days, 86_400) +
    unitSeconds(groups.hours, 3600) +
    unitSeconds(groups.minutes, 60) +
    unitSeconds(groups.seconds, 1)
  );
};

interface YouTubeApiParams {
  readonly id?: string;
  readonly maxResults?: string;
  /** Absent on the first page of a list. */
  readonly pageToken?: string | undefined;
  readonly part: string;
  readonly playlistId?: string;
}

const youTubeApiRequest = (
  resource: "playlistItems" | "playlists" | "videos",
  apiKey: string,
  params: YouTubeApiParams
): string => {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
  for (const [name, value] of Object.entries({ ...params, key: apiKey })) {
    if (value !== undefined) {
      url.searchParams.set(name, value);
    }
  }
  url.searchParams.sort();
  return url.toString();
};

const youTubeRequest = (videoId: string, apiKey: string): string =>
  youTubeApiRequest("videos", apiKey, {
    id: videoId,
    part: "snippet,contentDetails",
  });

const soundCloudRequest = (url: string): string => {
  const endpoint = new URL("https://soundcloud.com/oembed");
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("url", url);
  return endpoint.toString();
};

const requestJson = <S extends Schema.ConstraintDecoder<unknown>>(
  url: string,
  schema: S,
  options: ProviderOptions
): Effect.Effect<S["Type"], MetadataError> =>
  Effect.gen(function* readProvider() {
    const response = yield* Effect.tryPromise({
      catch: () => unavailable(`${options.label} is unreachable.`),
      try: (signal) => options.request(url, signal),
    });
    if (!response.ok) {
      return yield* Effect.fail(
        response.status >= 500
          ? unavailable(`${options.label} answered ${response.status}.`)
          : rejected(`${options.label} rejected this request.`)
      );
    }
    const body: unknown = yield* Effect.tryPromise({
      catch: () => unexpected(`${options.label} did not answer with JSON.`),
      try: () => response.json(),
    });
    const decoded = Schema.decodeUnknownOption(schema)(body);
    if (Option.isNone(decoded)) {
      return yield* Effect.fail(
        unexpected(`${options.label} omitted the fields Orbis reads.`)
      );
    }
    return decoded.value;
  }).pipe(
    Effect.timeoutOrElse({
      duration: PROVIDER_TIMEOUT,
      orElse: () =>
        Effect.fail(unavailable(`${options.label} did not answer in time.`)),
    })
  );

const YouTubeThumbnail = Schema.Struct({ url: Schema.String });

const YouTubeVideoSchema = Schema.Struct({
  contentDetails: Schema.Struct({ duration: Schema.String }),
  snippet: Schema.Struct({
    channelTitle: Schema.String,
    publishedAt: Schema.String,
    thumbnails: Schema.Struct({
      default: Schema.optionalKey(YouTubeThumbnail),
      high: Schema.optionalKey(YouTubeThumbnail),
      maxres: Schema.optionalKey(YouTubeThumbnail),
      medium: Schema.optionalKey(YouTubeThumbnail),
      standard: Schema.optionalKey(YouTubeThumbnail),
    }),
    title: Schema.String,
  }),
});

const YouTubeResponse = Schema.Struct({
  items: Schema.Array(YouTubeVideoSchema),
});

const SoundCloudResponse = Schema.Struct({
  author_name: Schema.optionalKey(Schema.String),
  thumbnail_url: Schema.optionalKey(Schema.String),
  title: Schema.String,
});

const YouTubeVideoIds = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ id: Schema.String, ...YouTubeVideoSchema.fields })
  ),
});

const YouTubePlaylistResponse = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      contentDetails: Schema.Struct({ itemCount: Schema.Number }),
      snippet: Schema.Struct({ title: Schema.String }),
    })
  ),
});

const YouTubePlaylistItemsResponse = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ contentDetails: Schema.Struct({ videoId: Schema.String }) })
  ),
  nextPageToken: Schema.optionalKey(Schema.String),
});

type YouTubeVideo = (typeof YouTubeResponse.Type)["items"][number];
type YouTubeThumbnails = YouTubeVideo["snippet"]["thumbnails"];
type SoundCloudOEmbed = typeof SoundCloudResponse.Type;

/** The image a listing draws: `medium` is 320x180, which is an 88-point row at 3x. */
const listingArtworkFrom = (thumbnails: YouTubeThumbnails): string | null =>
  thumbnails.medium?.url ??
  thumbnails.high?.url ??
  thumbnails.standard?.url ??
  thumbnails.default?.url ??
  null;

/** The image a Set's own page draws: the sharpest the video has. */
const pageArtworkFrom = (thumbnails: YouTubeThumbnails): string | null =>
  thumbnails.maxres?.url ??
  thumbnails.standard?.url ??
  thumbnails.high?.url ??
  thumbnails.medium?.url ??
  thumbnails.default?.url ??
  null;

const youTubeMetadata = (video: YouTubeVideo): EnrichedMetadata => ({
  artworkLargeUrl: pageArtworkFrom(video.snippet.thumbnails),
  artworkUrl: listingArtworkFrom(video.snippet.thumbnails),
  creator: video.snippet.channelTitle.trim() || null,
  durationSeconds: parseDurationSeconds(video.contentDetails.duration),
  releasedAt: video.snippet.publishedAt,
  title: video.snippet.title.trim(),
});

/** SoundCloud's oEmbed names one image and no size to ask for, so both places draw it. */
const soundCloudMetadata = (track: SoundCloudOEmbed): EnrichedMetadata => ({
  artworkLargeUrl: track.thumbnail_url ?? null,
  artworkUrl: track.thumbnail_url ?? null,
  creator: track.author_name?.trim() || null,
  durationSeconds: null,
  releasedAt: null,
  title: track.title.trim(),
});

const youTubeProvider = (
  youTubeApiKey: string,
  request: RequestFetch
): Provider => ({
  enrich: (url) =>
    Effect.gen(function* enrichYouTube() {
      const videoId = youTubeVideoId(url);
      if (!videoId) {
        return yield* Effect.fail(
          unsupported("This URL does not name a YouTube video.")
        );
      }
      const response = yield* requestJson(
        youTubeRequest(videoId, youTubeApiKey),
        YouTubeResponse,
        { label: "YouTube", request }
      );
      const [video] = response.items;
      if (!video) {
        return yield* Effect.fail(
          rejected("YouTube does not have this video.")
        );
      }
      const metadata = youTubeMetadata(video);
      if (!metadata.title) {
        return yield* Effect.fail(
          unexpected("YouTube returned a video without a title.")
        );
      }
      return metadata;
    }),
});

/** The Data API's largest page, for both playlist entries and a batch of videos. */
const YOUTUBE_PAGE = 50;

const chunks = <A>(values: readonly A[], size: number): A[][] =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, (index + 1) * size)
  );

/**
 * Three reads, each one quota unit: the playlist's name, its entries a page at a time, and the
 * entries' videos fifty at a time. The videos are the same records a single save reads, so an
 * imported track and a pasted one get the same title, artwork, and length.
 */
const readYouTubePlaylist = (
  playlistId: string,
  youTubeApiKey: string,
  request: RequestFetch
): Effect.Effect<YouTubePlaylist, MetadataError> =>
  Effect.gen(function* readPlaylist() {
    const options = { label: "YouTube", request };
    const found = yield* requestJson(
      youTubeApiRequest("playlists", youTubeApiKey, {
        id: playlistId,
        part: "snippet,contentDetails",
      }),
      YouTubePlaylistResponse,
      options
    );
    const [playlist] = found.items;
    if (!playlist) {
      return yield* Effect.fail(
        rejected("YouTube does not have this playlist, or it is private.")
      );
    }
    const ids: string[] = [];
    let entriesRead = 0;
    let pageToken: string | undefined;
    do {
      const page = yield* requestJson(
        youTubeApiRequest("playlistItems", youTubeApiKey, {
          maxResults: String(YOUTUBE_PAGE),
          pageToken,
          part: "contentDetails",
          playlistId,
        }),
        YouTubePlaylistItemsResponse,
        options
      );
      entriesRead += page.items.length;
      for (const { contentDetails } of page.items) {
        if (!ids.includes(contentDetails.videoId)) {
          ids.push(contentDetails.videoId);
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken && ids.length < MAX_SETS_PER_PLAYLIST);
    const unread = pageToken
      ? Math.max(0, playlist.contentDetails.itemCount - entriesRead)
      : 0;
    const overLimit = Math.max(0, ids.length - MAX_SETS_PER_PLAYLIST) + unread;
    const kept = ids.slice(0, MAX_SETS_PER_PLAYLIST);
    const videos = new Map<string, EnrichedMetadata>();
    for (const batch of chunks(kept, YOUTUBE_PAGE)) {
      const response = yield* requestJson(
        youTubeApiRequest("videos", youTubeApiKey, {
          id: batch.join(","),
          maxResults: String(YOUTUBE_PAGE),
          part: "snippet,contentDetails",
        }),
        YouTubeVideoIds,
        options
      );
      for (const video of response.items) {
        const metadata = youTubeMetadata(video);
        if (metadata.title) {
          videos.set(video.id, metadata);
        }
      }
    }
    const tracks = kept.flatMap((id) => {
      const metadata = videos.get(id);
      return metadata
        ? [{ metadata, url: `https://www.youtube.com/watch?v=${id}` }]
        : [];
    });
    return {
      overLimit,
      title: playlist.snippet.title.trim(),
      tracks,
      unavailable: kept.length - tracks.length,
    };
  });

const soundCloudProvider = (request: RequestFetch): Provider => ({
  enrich: (url) =>
    Effect.gen(function* enrichSoundCloud() {
      const response = yield* requestJson(
        soundCloudRequest(url),
        SoundCloudResponse,
        { label: "SoundCloud", request }
      );
      const metadata = soundCloudMetadata(response);
      if (!metadata.title) {
        return yield* Effect.fail(
          unexpected("SoundCloud returned a track without a title.")
        );
      }
      return metadata;
    }),
});

const enrichedFromDetails = (details: SourceDetails): EnrichedMetadata => ({
  artworkLargeUrl: details.thumbnailUrl,
  artworkUrl: details.thumbnailUrl,
  creator: details.creator,
  durationSeconds: details.durationSeconds,
  extras: {
    chapters: details.chapters,
    creatorId: details.creatorId,
    creatorUrl: details.creatorUrl,
    description: details.description,
    genre: details.genre,
    tags: details.tags,
  },
  releasedAt: details.releasedAt,
  title: details.title,
});

/**
 * yt-dlp is slow, so it is only the answer here when the provider API has none: a source with no
 * API configured, or one that failed. Otherwise the save returns on the provider alone and
 * `details` fills the rest afterwards.
 */
const orYtDlp = (
  provider: Effect.Effect<EnrichedMetadata, MetadataError>,
  ytDlp: YtDlpMetadataService,
  url: string
): Effect.Effect<EnrichedMetadata, MetadataError> =>
  Effect.gen(function* answerOrFallBack() {
    const answer = yield* Effect.result(provider);
    if (answer._tag === "Success") {
      return answer.success;
    }
    const details = yield* Effect.result(ytDlp.read(url));
    return yield* details._tag === "Success"
      ? Effect.succeed(enrichedFromDetails(details.success))
      : Effect.fail(answer.failure);
  });

const noProviders: MetadataService = {
  details: (input) =>
    Effect.fail(
      notConfigured(
        `${input.source} details are not configured on this server.`
      )
    ),
  enrich: (input) =>
    Effect.fail(
      notConfigured(
        `${input.source} enrichment is not configured on this server.`
      )
    ),
  playlist: () =>
    Effect.fail(
      notConfigured("YouTube playlists are not configured on this server.")
    ),
};

export class Metadata extends Context.Service<Metadata, MetadataService>()(
  "@orbis/Metadata"
) {
  static layer(options: MetadataOptions = {}): Layer.Layer<Metadata> {
    const request = options.fetch ?? ((url, signal) => fetch(url, { signal }));
    const providers: Partial<Record<SetSource, Provider>> = {
      soundcloud: soundCloudProvider(request),
    };
    if (options.youTubeApiKey) {
      providers.youtube = youTubeProvider(options.youTubeApiKey, request);
    }
    const { ytDlp, youTubeApiKey } = options;
    return Layer.succeed(
      Metadata,
      Metadata.of({
        details: Effect.fn("Metadata.details")((input: EnrichInput) =>
          ytDlp ? ytDlp.read(input.url) : noProviders.details(input)
        ),
        enrich: Effect.fn("Metadata.enrich")((input: EnrichInput) => {
          const provider =
            providers[input.source]?.enrich(input.url) ??
            noProviders.enrich(input);
          return ytDlp ? orYtDlp(provider, ytDlp, input.url) : provider;
        }),
        playlist: Effect.fn("Metadata.playlist")((playlistId: string) =>
          youTubeApiKey
            ? readYouTubePlaylist(playlistId, youTubeApiKey, request)
            : noProviders.playlist(playlistId)
        ),
      })
    );
  }

  /**
   * No provider is reachable. This is the default so that a save never waits on the network
   * unless a caller asks for providers, which keeps tests offline by construction.
   */
  static unconfigured(): Layer.Layer<Metadata> {
    return Layer.succeed(Metadata, noProviders);
  }

  static layerOf(
    metadata: Pick<MetadataService, "enrich"> &
      Partial<Pick<MetadataService, "details" | "playlist">>
  ): Layer.Layer<Metadata> {
    return Layer.succeed(
      Metadata,
      Metadata.of({
        details: noProviders.details,
        playlist: noProviders.playlist,
        ...metadata,
      })
    );
  }
}
