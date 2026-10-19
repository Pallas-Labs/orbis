import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createApp } from "../apps/server/src/app.js";
import { startFixtureServer } from "../apps/server/src/fixture-server.js";
import { hashToken } from "../apps/server/src/identity.js";
import { Metadata } from "../apps/server/src/metadata.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const dataDirectory = required("ORBIS_FIXTURE_DATA_DIR");
const token =
  process.env.ORBIS_FIXTURE_TOKEN ?? randomBytes(32).toString("base64url");
const settingsToken =
  process.env.ORBIS_FIXTURE_SETTINGS_TOKEN ??
  randomBytes(32).toString("base64url");
const devicesPath = path.join(dataDirectory, "devices.json");
const databasePath = path.join(dataDirectory, "library.sqlite");
await mkdir(dataDirectory, { recursive: true });
if (await Bun.file(devicesPath).exists()) {
  throw new Error("ORBIS_FIXTURE_DATA_DIR must not contain devices.json.");
}
const addedAt = new Date().toISOString();
await writeFile(
  devicesPath,
  JSON.stringify({
    keys: [
      {
        addedAt,
        id: "fixture-key",
        label: "Fixture",
        lastUsedAt: null,
        personId: "host",
        scope: "daily",
        tokenHash: hashToken(token),
      },
      {
        addedAt,
        id: "fixture-settings-key",
        label: "Fixture settings",
        lastUsedAt: null,
        personId: "fixture-settings",
        scope: "daily",
        tokenHash: hashToken(settingsToken),
      },
    ],
    people: [
      { autoDownload: false, id: "host", removed: false, username: "host" },
      {
        autoDownload: false,
        id: "fixture-settings",
        removed: false,
        username: "lane-settings",
      },
    ],
    version: 2,
  })
);
const audioFile = process.env.ORBIS_FIXTURE_AUDIO_FILE;
const cobaltUrl = audioFile
  ? "http://cobalt.fixture.test/"
  : process.env.ORBIS_COBALT_URL;
const fixtureAudio = audioFile ? Bun.file(audioFile) : undefined;
/**
 * The Data API as the lane sees it: one public playlist, answered from memory the way Google
 * would, so an import journey needs no network and no key. It has 60 entries, more than one
 * page, so the import shows progress between pages. Every other read is refused, which leaves a
 * single save without provider metadata, as it was before this fake.
 */
const LANE_PAGE = 50;
const LANE_SECOND_PAGE_DELAY_MS = 4000;
const LANE_PLAYLIST = {
  entries: [
    ["laneMix0001", "Sunrise on the Pier", "Avery Coast"],
    ["laneMix0002", "Low Tide Dub", "Harbour Unit"],
    ["laneMixGone", "", ""],
    ["laneMix0003", "Night Ferry", "Avery Coast"],
    ["laneMix0004", "Salt and Static", "Mira Holt"],
    ["laneMix0005", "Last Light Session", "Harbour Unit"],
    ...Array.from({ length: 54 }, (_, index) => {
      const n = String(index + 6).padStart(4, "0");
      return [`laneMix${n}`, `Lane Track ${n}`, "Lane Artist"] as const;
    }),
  ],
  id: "PLorbisLaneMix",
  title: "Lane Mix",
} as const;
interface DataApiAnswer {
  readonly items: readonly unknown[];
  readonly nextPageToken?: string | undefined;
}
const answer = (body: DataApiAnswer) => Promise.resolve(Response.json(body));
const laneYouTube = async (url: string) => {
  const parsed = new URL(url);
  const resource = parsed.pathname.split("/").at(-1);
  if (resource === "playlists") {
    return answer({
      items:
        parsed.searchParams.get("id") === LANE_PLAYLIST.id
          ? [
              {
                contentDetails: { itemCount: LANE_PLAYLIST.entries.length },
                snippet: { title: LANE_PLAYLIST.title },
              },
            ]
          : [],
    });
  }
  if (resource === "playlistItems") {
    const start = Number(parsed.searchParams.get("pageToken") ?? "0");
    if (start > 0) {
      // A slow second page keeps the import's progress on screen long enough to see. It stays
      // under the server's five-second provider timeout, past which the page would fail.
      await Bun.sleep(LANE_SECOND_PAGE_DELAY_MS);
    }
    const next = start + LANE_PAGE;
    return answer({
      items: LANE_PLAYLIST.entries
        .slice(start, next)
        .map(([videoId]) => ({ contentDetails: { videoId } })),
      nextPageToken:
        next < LANE_PLAYLIST.entries.length ? String(next) : undefined,
    });
  }
  if (resource === "videos") {
    const ids = new Set(parsed.searchParams.get("id")?.split(","));
    return answer({
      items: LANE_PLAYLIST.entries
        .filter(([id, title]) => ids.has(id) && title)
        .map(([id, title, channelTitle]) => ({
          contentDetails: { duration: "PT58M12S" },
          id,
          snippet: {
            channelTitle,
            publishedAt: "2026-06-01T00:00:00Z",
            thumbnails: {},
            title,
          },
        })),
    });
  }
  return new Response("not found", { status: 404 });
};
const app = createApp({
  audio: {
    audioDir: path.join(dataDirectory, "audio"),
    cobaltApiKey: process.env.ORBIS_COBALT_API_KEY,
    cobaltUrl,
    fetch: fixtureAudio
      ? async (url) =>
          url.startsWith(cobaltUrl ?? "")
            ? Response.json({
                status: "tunnel",
                url: "http://cdn.fixture.test/ready-set.m4a",
              })
            : new Response(await fixtureAudio.arrayBuffer(), {
                headers: { "content-type": "audio/mp4" },
              })
      : undefined,
    startWorker: true,
    ytdlpBin: process.env.ORBIS_YTDLP_BIN,
    ytdlpCookies: process.env.ORBIS_YTDLP_COOKIES,
  },
  databasePath,
  devicesPath,
  logging: { silent: true },
  metadata: Metadata.layer({ fetch: laneYouTube, youTubeApiKey: "lane" }),
  playbackDiagnostics: {
    accessClientId:
      process.env.ORBIS_FIXTURE_SIGNOZ_OTLP_ACCESS_CLIENT_ID ?? "",
    accessClientSecret:
      process.env.ORBIS_FIXTURE_SIGNOZ_OTLP_ACCESS_CLIENT_SECRET ?? "",
    url:
      process.env.ORBIS_FIXTURE_SIGNOZ_OTLP_URL ??
      "https://otlp.parthm.me/v1/logs",
  },
});
const fixture = await startFixtureServer({
  allowedOrigin: process.env.ORBIS_FIXTURE_ORIGIN,
  app,
  port: Number(process.env.ORBIS_FIXTURE_PORT ?? 0),
  token,
});
process.stdout.write(
  `${JSON.stringify({
    address: fixture.url.toString().replace(/\/$/u, ""),
    settingsToken,
    token,
  })}\n`
);
const close = async () => {
  await fixture.stop();
  if (process.env.ORBIS_FIXTURE_REMOVE_DATA === "true") {
    await rm(dataDirectory, { force: true, recursive: true });
  }
  process.exit(0);
};
process.once("SIGINT", () => close());
process.once("SIGTERM", () => close());
