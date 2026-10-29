export { Group } from "./group.js";

export interface Environment {
  readonly STREAM_GRANT_SECRET: string;
  readonly AUDIO_NODE_URL: string;
  readonly SIGNOZ_OTLP_URL?: string;
  readonly SIGNOZ_OTLP_ACCESS_CLIENT_ID?: string;
  readonly SIGNOZ_OTLP_ACCESS_CLIENT_SECRET?: string;
  readonly YOUTUBE_API_KEY?: string;
  readonly APPLE_MUSIC_TEAM_ID?: string;
  readonly APPLE_MUSIC_KEY_ID?: string;
  readonly APPLE_MUSIC_PRIVATE_KEY?: string;
  readonly OPENROUTER_API_KEY?: string;
  readonly VERSOS_URL?: string;
  readonly VERSOS_API_KEY?: string;
  readonly IMPORT_NODE_KEY_DIGEST?: string;
  readonly GROUP: DurableObjectNamespace;
}

const SHARE_IMAGE = /^\/api\/+share\/+sets\/+(?<id>[^/]+)\/+image\.png\/?$/iu;

/**
 * The cache key of a versioned Orbis Link preview image, built from the Set ID and version
 * alone so that other query strings and spellings of the ID share one entry, or null.
 */
const shareImageKey = (request: Request, url: URL): string | null => {
  const version = url.searchParams.get("v");
  if (request.method !== "GET" || !version) {
    return null;
  }
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const id = SHARE_IMAGE.exec(path)?.groups?.id;
  return id
    ? `https://${url.host}/api/share/sets/${encodeURIComponent(id)}/image.png?v=${encodeURIComponent(version)}`
    : null;
};

declare global {
  /** Workerd's zone cache, which the DOM lib this package also loads leaves out. */
  interface CacheStorage {
    readonly default: Cache;
  }
}

export default {
  async fetch(
    request: Request,
    env: Environment,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }
    const key = shareImageKey(request, url);
    if (key) {
      const cached = await caches.default.match(key);
      if (cached) {
        return cached;
      }
    }
    url.pathname = url.pathname.slice(4);
    const response = await env.GROUP.getByName("group").fetch(
      new Request(url, request)
    );
    if (
      key &&
      response.status === 200 &&
      response.headers.get("content-type") === "image/png"
    ) {
      ctx.waitUntil(caches.default.put(key, response.clone()));
    }
    return response;
  },
};
