import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { HttpServerResponse } from "effect/unstable/http";

import { makeAlarmScheduler } from "../../server/src/alarm-scheduler.js";
import { createPortableApp } from "../../server/src/app-core.js";
import { releaseAudio } from "../../server/src/audio-release.js";
import { Library } from "../../server/src/library.js";
import {
  finishRequestLog,
  outcomeForStatus,
  startRequestLog,
} from "../../server/src/logging.js";
import type { LoggingOptions } from "../../server/src/logging.js";
import { Metadata } from "../../server/src/metadata.js";
import { issueStreamGrant } from "../../server/src/stream-grant-core.js";
import { TitleReviser } from "../../server/src/title-reviser.js";
import { Versos } from "../../server/src/versos.js";
import { makeAudioLayer } from "./audio.js";
import { transferRequest } from "./data-transfer.js";
import { databaseLayer } from "./database.js";
import type { Environment } from "./index.js";
import { GroupAudioNode } from "./node.js";
import { recoverHost } from "./recovery.js";
import { registerTrustStorage } from "./trust-storage.js";

/**
 * The Group's events go to Workers Logs and, with Access credentials, to SigNoz
 * through the endpoint the playback relay already uses.
 */
const groupLogging = (
  ctx: DurableObjectState,
  env: Environment
): LoggingOptions => {
  const id = env.SIGNOZ_OTLP_ACCESS_CLIENT_ID;
  const secret = env.SIGNOZ_OTLP_ACCESS_CLIENT_SECRET;
  const otlp =
    id && secret
      ? {
          component: "group" as const,
          headers: {
            "CF-Access-Client-Id": id,
            "CF-Access-Client-Secret": secret,
          },
          url: env.SIGNOZ_OTLP_URL ?? "https://otlp.parthm.me/v1/logs",
          waitUntil: (promise: Promise<unknown>) => {
            ctx.waitUntil(promise);
          },
        }
      : undefined;
  return { otlp, pretty: false, silent: false };
};

export class Group extends DurableObject<Environment> {
  private readonly alarms;
  private readonly app;
  private readonly logging: LoggingOptions;
  private readonly node: GroupAudioNode;
  constructor(ctx: DurableObjectState, env: Environment) {
    super(ctx, env);
    const trustPath = ctx.id.toString();
    registerTrustStorage(trustPath, ctx.storage);
    if (!/^[a-fA-F0-9]{64}$/u.test(env.STREAM_GRANT_SECRET)) {
      throw new Error("STREAM_GRANT_SECRET must encode 32 bytes as hex.");
    }
    const streamSecret = Buffer.from(env.STREAM_GRANT_SECRET, "hex");
    const audioNode = URL.parse(env.AUDIO_NODE_URL);
    if (audioNode?.protocol !== "https:" && audioNode?.protocol !== "http:") {
      throw new Error("AUDIO_NODE_URL must be an absolute http(s) URL.");
    }
    const database = databaseLayer(ctx.storage);
    const release = (id: string) =>
      releaseAudio(id, undefined, (releasedId) =>
        Effect.sync(() => this.node.release(releasedId))
      );
    const runtime = ManagedRuntime.make(
      Library.forPersonLayer("host", { releaseAudio: release }).pipe(
        Layer.provideMerge(database)
      )
    );
    this.logging = groupLogging(ctx, env);
    this.node = new GroupAudioNode(ctx, runtime, trustPath, this.logging);
    // Answered without waking the Group; the node reconnects when a ping goes unanswered.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
    this.alarms = makeAlarmScheduler({
      deleteAlarm: () => ctx.storage.deleteAlarm(),
      setAlarm: (at) => ctx.storage.setAlarm(at),
    });
    this.app = createPortableApp({
      audio: makeAudioLayer(this.node),
      audioResponse: (_file, _range, setId, personId, grant) => {
        const url = new URL(
          `/api/sets/${encodeURIComponent(setId)}/audio`,
          audioNode
        );
        url.searchParams.set(
          "grant",
          grant ?? issueStreamGrant(streamSecret, setId, personId)
        );
        return HttpServerResponse.redirect(url.toString(), { status: 302 });
      },
      database,
      logging: this.logging,
      metadata: Metadata.layer({
        appleMusic:
          env.APPLE_MUSIC_TEAM_ID &&
          env.APPLE_MUSIC_KEY_ID &&
          env.APPLE_MUSIC_PRIVATE_KEY
            ? {
                keyId: env.APPLE_MUSIC_KEY_ID,
                privateKey: env.APPLE_MUSIC_PRIVATE_KEY,
                teamId: env.APPLE_MUSIC_TEAM_ID,
              }
            : undefined,
        youTubeApiKey: env.YOUTUBE_API_KEY,
        ytDlp: { read: this.node.readDetails },
      }),
      playbackDiagnostics: {
        accessClientId: env.SIGNOZ_OTLP_ACCESS_CLIENT_ID ?? "",
        accessClientSecret: env.SIGNOZ_OTLP_ACCESS_CLIENT_SECRET ?? "",
        environment: "production",
        url: env.SIGNOZ_OTLP_URL ?? "https://otlp.parthm.me/v1/logs",
      },
      playlistImports: { heartbeat: this.alarms.slot("playlist-imports") },
      presence: { alarm: this.alarms.slot("presence") },
      releaseAudio: release,
      streamSecret,
      titleReviser: TitleReviser.layer({ apiKey: env.OPENROUTER_API_KEY }),
      trustPath,
      versos:
        env.VERSOS_URL && env.VERSOS_API_KEY
          ? Versos.layer({
              key: Redacted.make(env.VERSOS_API_KEY),
              url: env.VERSOS_URL,
            })
          : Versos.unconfigured(),
    });
    ctx.blockConcurrencyWhile(async () => {
      const response = await this.app.initialize();
      if (!response.ok) {
        throw new Error("Group database initialization failed.");
      }
    });
  }
  override async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    try {
      await this.node.message(socket, message);
    } catch {
      this.node.disconnected(socket, 1011);
    }
  }

  override webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string
  ): void {
    this.node.disconnected(socket, code, reason);
  }

  override webSocketError(socket: WebSocket): void {
    this.node.disconnected(socket, 1011);
  }

  override async alarm(): Promise<void> {
    this.alarms.fired(Date.now());
    const [presence, imports] = await Promise.allSettled([
      this.app.expirePresence(),
      this.app.resumeImports(),
    ]);
    await this.alarms.sync();
    // A failure makes Cloudflare run the alarm again.
    for (const outcome of [presence, imports]) {
      if (outcome.status === "rejected") {
        throw outcome.reason;
      }
    }
  }

  override fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/recovery") {
      const logger = startRequestLog({
        method: request.method,
        path: "/api/recovery",
        requestId: crypto.randomUUID(),
      });
      const response = recoverHost(request, this.ctx.id.toString());
      finishRequestLog(
        logger,
        { outcome: outcomeForStatus(response.status), status: response.status },
        this.logging
      );
      return Promise.resolve(response);
    }
    if (new URL(request.url).pathname === "/node") {
      return Promise.resolve(this.node.accept(request));
    }
    if (
      request.method === "GET" &&
      new URL(request.url).pathname === "/health"
    ) {
      return this.app.initialize();
    }
    const path = new URL(request.url).pathname;
    if (path === "/import" || path === "/export") {
      return transferRequest({
        bootstrapDigest: this.env.IMPORT_NODE_KEY_DIGEST,
        request,
        storage: this.ctx.storage,
        trustPath: this.ctx.id.toString(),
      });
    }
    return this.app.handler(
      request,
      "device",
      request.headers.get("CF-Connecting-IP") ?? "unknown"
    );
  }
}
