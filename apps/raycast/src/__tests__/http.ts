import { Predicate } from "effect";

export interface RecordedRequest {
  readonly body: string;
  readonly headers: Record<string, string>;
  readonly url: string;
}

export const requests: RecordedRequest[] = [];

export const resetRequests = () => {
  requests.length = 0;
};

export type FetchHandler = (
  request: RecordedRequest,
  init: RequestInit
) => Promise<Response> | Response;

/** The request body as text: the client sends bytes, and a test may send a string. */
const bodyText = (body: RequestInit["body"]): string => {
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  return Predicate.isString(body) ? body : "";
};

/**
 * Replaces the global fetch and records each request, so a test can assert both that no
 * request was sent and exactly what Orbis would have received.
 */
export const mockFetch = (handler: FetchHandler) => {
  const implementation = (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const request: RecordedRequest = {
      body: bodyText(init.body),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      url: input instanceof Request ? input.url : input.toString(),
    };
    requests.push(request);
    return Promise.resolve(handler(request, init));
  };
  // Raycast's fetch carries a preconnect hint; pass the original's through.
  globalThis.fetch = Object.assign(implementation, {
    preconnect: fetch.preconnect,
  });
};

export const httpStatus = (status: number): Response =>
  status === 201
    ? Response.json(
        {
          artworkLargeUrl: null,
          artworkUrl: null,
          autoDownloadResult: "unavailable",
          createdAt: "2026-01-01T00:00:00.000Z",
          creator: null,
          creatorId: null,
          downloadState: "none",
          durationSeconds: null,
          finishCount: 0,
          id: "saved-set",
          lastListenedAt: null,
          listenCount: 0,
          metadataState: "pending",
          playbackPositionSeconds: 0,
          playlistIds: [],
          releasedAt: null,
          retainedAudioBytes: null,
          retainedAudioFormat: null,
          source: "youtube",
          tags: [],
          title: "Saved set",
          titleEditedByUser: false,
          tracklistState: "pending",
          url: "https://www.youtube.com/watch?v=abcdefghijk",
        },
        { status }
      )
    : new Response(null, { status });
