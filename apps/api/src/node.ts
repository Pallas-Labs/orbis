/* oxlint-disable unicorn/no-array-method-this-argument -- Effect.flatMap accepts an Effect and callback, not an Array thisArg. */
import { NodeMessageSchema } from "@orbis/contracts/node";
import type {
  NodeCommand,
  NodeMessage,
  SourceDetails,
} from "@orbis/contracts/node";
import { sql } from "drizzle-orm";
import { Effect, Schema, Semaphore } from "effect";
import type { ManagedRuntime } from "effect";

import { Database } from "../../server/src/db/service.js";
import {
  decideNodeAccess,
  readTrustRegistry,
} from "../../server/src/identity.js";
import { Library } from "../../server/src/library.js";
import { logEvent } from "../../server/src/logging.js";
import type { LoggingOptions } from "../../server/src/logging.js";
import { MetadataError } from "../../server/src/metadata-error.js";

const decodeNodeMessage = Schema.decodeUnknownSync(NodeMessageSchema);

/** The node-key check `/node` and `/recovery` share: the key's id, or a refusal. */
export const nodeKeyId = (
  request: Request,
  trustPath: string
): string | Response => {
  const decision = decideNodeAccess({
    authorization: request.headers.get("authorization"),
    hasOrigin: request.headers.has("origin"),
    host: new URL(request.url).host,
    mode: "device",
    store: readTrustRegistry(trustPath).store,
  });
  if (decision.kind === "rejected") {
    return Response.json(
      { message: decision.message },
      { status: decision.statusCode }
    );
  }
  return decision.keyId ?? new Response("Node key required", { status: 403 });
};

const AttachmentSchema = Schema.Struct({
  /** Unique per accept; the newest socket's value is the stored one. */
  acceptedAt: Schema.Number,
  active: Schema.NullOr(
    Schema.Struct({ requestId: Schema.String, setId: Schema.String })
  ),
  detailRequests: Schema.Array(
    Schema.Struct({ requestId: Schema.String, setId: Schema.String })
  ),
  keyId: Schema.String,
  progress: Schema.NullOr(
    Schema.Struct({
      received: Schema.Number,
      total: Schema.NullOr(Schema.Number),
    })
  ),
  ready: Schema.Boolean,
});
const decodeAttachment = Schema.decodeUnknownSync(AttachmentSchema);

type Attachment = typeof AttachmentSchema.Type;
type Details = typeof SourceDetails.Type;

const ACCEPTED_AT_KEY = "orbis:node-accepted-at";

export class GroupAudioNode {
  private tail = Promise.resolve();
  private readonly detailSlots = Semaphore.makeUnsafe(2);
  private readonly details = new Map<
    string,
    {
      command: Extract<NodeCommand, { kind: "read-details" }>;
      resolve: (value: Details) => void;
      reject: (error: Error) => void;
    }
  >();

  private readonly ctx: DurableObjectState;
  private readonly runtime: ManagedRuntime.ManagedRuntime<
    Library | Database,
    unknown
  >;
  private readonly trustPath: string;
  private readonly logging: LoggingOptions;

  constructor(
    ctx: DurableObjectState,
    runtime: ManagedRuntime.ManagedRuntime<Library | Database, unknown>,
    trustPath: string,
    logging: LoggingOptions = {}
  ) {
    this.ctx = ctx;
    this.runtime = runtime;
    this.trustPath = trustPath;
    this.logging = logging;
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    const next = (async () => {
      await previous;
      return await operation();
    })();
    this.tail = (async () => {
      try {
        await next;
      } catch {
        // The caller receives the error; later messages still run.
      }
    })();
    return await next;
  }

  private static attachment(socket: WebSocket): Attachment {
    return decodeAttachment(socket.deserializeAttachment());
  }

  private socket() {
    const socket = this.ctx
      .getWebSockets("node")
      .find((candidate) => candidate.readyState === WebSocket.OPEN);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const attached = GroupAudioNode.attachment(socket);
    const { store } = readTrustRegistry(this.trustPath);
    const key = store.keys.find(
      (candidate) =>
        candidate.id === attached.keyId && candidate.scope === "node"
    );
    if (
      !key ||
      !store.people.some(
        (person) => person.id === key.personId && !person.removed
      )
    ) {
      socket.close(1008, "Node key revoked");
      return;
    }
    return socket;
  }

  accept(request: Request): Response {
    const keyId = nodeKeyId(request, this.trustPath);
    if (keyId instanceof Response) {
      return keyId;
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }
    const previous = this.ctx.getWebSockets("node");
    for (const replaced of previous) {
      // The node reconnects only after it loses its link. A link still open
      // here was lost before its close reached the Group, which can take minutes.
      if (replaced.readyState === WebSocket.OPEN) {
        logEvent(
          "warn",
          {
            ageMs: Date.now() - GroupAudioNode.attachment(replaced).acceptedAt,
            current: true,
            event: "group-node-disconnected",
            reason: "Node reconnected before the close arrived",
          },
          this.logging
        );
      }
      replaced.close(1000, "Node replaced");
    }
    const acceptedAt = Math.max(
      Date.now(),
      (this.ctx.storage.kv.get<number>(ACCEPTED_AT_KEY) ?? 0) + 1
    );
    this.ctx.storage.kv.put(ACCEPTED_AT_KEY, acceptedAt);
    const pair = new WebSocketPair();
    const { 0: client, 1: server } = pair;
    this.ctx.acceptWebSocket(server, ["node"]);
    server.serializeAttachment({
      acceptedAt,
      active: null,
      detailRequests: [],
      keyId,
      progress: null,
      ready: false,
    } satisfies Attachment);
    logEvent(
      "info",
      { event: "group-node-accepted", replaced: previous.length },
      this.logging
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  progressFor(id: string) {
    const socket = this.socket();
    if (!socket) {
      return null;
    }
    const attached = GroupAudioNode.attachment(socket);
    return attached.active?.setId === id ? attached.progress : null;
  }

  private static send(socket: WebSocket, command: NodeCommand) {
    socket.send(JSON.stringify(command));
  }

  wake = async () => await this.serial(async () => await this.schedule());

  /**
   * Warns when Downloads wait while no node can take them, the state that kept
   * imports queued for a day unnoticed. Called once per schedule, so once per wake.
   */
  private warnIfWaiting(node: "connecting" | "missing") {
    const [waiting] = this.ctx.storage.sql
      .exec<{ queued: number; oldest: string | null }>(
        "SELECT COUNT(*) AS queued, MIN(download_jobs.queued_at) AS oldest FROM download_jobs JOIN sets ON sets.id = download_jobs.set_id WHERE sets.download_state = 'queued'"
      )
      .toArray();
    if (!waiting?.queued) {
      return;
    }
    logEvent(
      "warn",
      {
        event: "group-downloads-waiting",
        node,
        oldestQueuedMs:
          waiting.oldest === null
            ? null
            : Date.now() - Date.parse(waiting.oldest),
        queued: waiting.queued,
      },
      this.logging
    );
  }

  private async schedule() {
    const socket = this.socket();
    if (!socket) {
      this.warnIfWaiting("missing");
      return;
    }
    const attached = GroupAudioNode.attachment(socket);
    if (!attached.ready) {
      this.warnIfWaiting("connecting");
      return;
    }
    if (attached.active) {
      return;
    }
    const next = await this.runtime.runPromise(
      Library.pipe(Effect.flatMap((library) => library.claimDownload))
    );
    // An Apple Music Set is never queued (ADR 0021), so this only narrows the source.
    if (!next || next.source === "apple-music") {
      return;
    }
    const requestId = crypto.randomUUID();
    socket.serializeAttachment({
      ...GroupAudioNode.attachment(socket),
      active: { requestId, setId: next.id },
      progress: { received: 0, total: null },
    } satisfies Attachment);
    GroupAudioNode.send(socket, {
      kind: "start",
      requestId,
      setId: next.id,
      source: next.source,
      url: next.url,
    });
    logEvent(
      "info",
      {
        event: "group-download-started",
        requestId,
        set: next.id,
        source: next.source,
      },
      this.logging
    );
  }

  cancel = async (id: string) =>
    await this.serial(async () => {
      const socket = this.socket();
      if (!socket) {
        return;
      }
      const attached = GroupAudioNode.attachment(socket);
      if (attached.active?.setId === id) {
        GroupAudioNode.send(socket, {
          kind: "cancel",
          requestId: attached.active.requestId,
          setId: id,
        });
        socket.serializeAttachment({
          ...GroupAudioNode.attachment(socket),
          active: null,
          progress: null,
        } satisfies Attachment);
      }
      await this.schedule();
    });

  release(id: string) {
    const socket = this.socket();
    if (!socket) {
      return;
    }
    const attached = GroupAudioNode.attachment(socket);
    GroupAudioNode.send(socket, {
      kind: "release",
      requestId: crypto.randomUUID(),
      setId: id,
    });
    if (attached.active?.setId === id) {
      socket.serializeAttachment({
        ...GroupAudioNode.attachment(socket),
        active: null,
        progress: null,
      } satisfies Attachment);
    }
    this.ctx.waitUntil(this.wake());
  }

  readDetails = (url: string) =>
    Effect.tryPromise({
      catch: (error) =>
        new MetadataError({
          message:
            error instanceof Error
              ? error.message
              : "Audio node details failed.",
          reason: "provider-unavailable",
        }),
      try: async (signal) =>
        // oxlint-disable-next-line promise/avoid-new -- The reply arrives through a later WebSocket event.
        await new Promise<Details>((resolve, reject) => {
          const socket = this.socket();
          const [set] = this.ctx.storage.sql
            .exec<{ id: string }>("SELECT id FROM sets WHERE url = ?", url)
            .toArray();
          if (!socket || !GroupAudioNode.attachment(socket).ready || !set) {
            reject(new Error("Audio node is unavailable."));
            return;
          }
          if (GroupAudioNode.attachment(socket).detailRequests.length >= 8) {
            reject(new Error("Audio node details are busy."));
            return;
          }
          const requestId = crypto.randomUUID();
          const command = {
            kind: "read-details",
            requestId,
            setId: set.id,
            url,
          } as const;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const cleanup = () => {
            clearTimeout(timer);
            timer = undefined;
            this.details.delete(requestId);
            // A reconnect moves the request to the newer socket.
            for (const carrier of this.ctx.getWebSockets("node")) {
              const current =
                carrier.readyState === WebSocket.OPEN
                  ? GroupAudioNode.attachment(carrier)
                  : undefined;
              if (
                current?.detailRequests.some(
                  (request) => request.requestId === requestId
                )
              ) {
                carrier.serializeAttachment({
                  ...current,
                  detailRequests: current.detailRequests.filter(
                    (request) => request.requestId !== requestId
                  ),
                } satisfies Attachment);
              }
            }
          };
          timer = setTimeout(() => {
            cleanup();
            reject(new Error("Audio node details timed out."));
          }, 15_000);
          signal.addEventListener(
            "abort",
            () => {
              cleanup();
              reject(new Error("Details read canceled."));
            },
            { once: true }
          );
          const attached = GroupAudioNode.attachment(socket);
          socket.serializeAttachment({
            ...GroupAudioNode.attachment(socket),
            detailRequests: [
              ...attached.detailRequests,
              { requestId, setId: set.id },
            ],
          } satisfies Attachment);
          this.details.set(requestId, {
            command,
            reject: (error) => {
              cleanup();
              reject(error);
            },
            resolve: (value) => {
              cleanup();
              resolve(value);
            },
          });
          GroupAudioNode.send(socket, command);
        }),
    }).pipe(this.detailSlots.withPermits(1));

  private async acceptDetails(
    socket: WebSocket,
    attached: Attachment,
    message: NodeMessage
  ): Promise<boolean> {
    if (message.kind === "details" || message.kind === "failed") {
      const requested = attached.detailRequests.some(
        (request) =>
          request.requestId === message.requestId &&
          request.setId === message.setId
      );
      if (requested) {
        socket.serializeAttachment({
          ...GroupAudioNode.attachment(socket),
          detailRequests: attached.detailRequests.filter(
            (request) => request.requestId !== message.requestId
          ),
        } satisfies Attachment);
        const pending = this.details.get(message.requestId);
        if (message.kind === "details") {
          await this.runtime.runPromise(
            Effect.flatMap(Library, (library) =>
              library.recordDetails(message.setId, message.details)
            )
          );
          pending?.resolve(message.details);
        } else {
          await this.runtime.runPromise(
            Effect.flatMap(Library, (library) =>
              library.recordDetailsFailure(message.setId)
            )
          );
          pending?.reject(new Error(message.reason));
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Pending details reads stay pending: the next socket's inventory re-sends
   * them, and their own timeout ends them when no node returns.
   */
  disconnected(socket: WebSocket, code: number, reason = "") {
    // 1005, 1006 and 1015 describe a close and cannot be sent, so close() throws on them.
    socket.close([1005, 1006, 1015].includes(code) ? 1011 : code);
    const { acceptedAt } = GroupAudioNode.attachment(socket);
    const ageMs = Date.now() - acceptedAt;
    // A replaced socket's close can arrive many minutes after its replacement,
    // which `accept` already counted as lost if it was still open.
    if (acceptedAt !== this.ctx.storage.kv.get<number>(ACCEPTED_AT_KEY)) {
      logEvent(
        "info",
        { ageMs, code, event: "group-node-replaced-closed", reason },
        this.logging
      );
      return;
    }
    logEvent(
      code === 1000 ? "info" : "warn",
      { ageMs, code, current: true, event: "group-node-disconnected", reason },
      this.logging
    );
  }

  async message(socket: WebSocket, data: string | ArrayBuffer) {
    return await this.serial(async () => {
      if (socket !== this.socket()) {
        return;
      }
      let message: NodeMessage;
      try {
        message = decodeNodeMessage(
          JSON.parse(
            data instanceof ArrayBuffer ? new TextDecoder().decode(data) : data
          )
        );
      } catch {
        socket.close(1008, "Invalid node message");
        return;
      }
      const attached = GroupAudioNode.attachment(socket);
      if (message.kind === "inventory") {
        if (attached.ready) {
          return;
        }
        await this.reconcile(socket, message.files);
        const resent = [...this.details.values()].map(
          (pending) => pending.command
        );
        socket.serializeAttachment({
          ...GroupAudioNode.attachment(socket),
          active: null,
          detailRequests: resent.map(({ requestId, setId }) => ({
            requestId,
            setId,
          })),
          progress: null,
          ready: true,
        } satisfies Attachment);
        for (const command of resent) {
          GroupAudioNode.send(socket, command);
        }
        await this.schedule();
        return;
      }
      if (!attached.ready) {
        socket.close(1008, "Inventory required");
        return;
      }
      if (await this.acceptDetails(socket, attached, message)) {
        return;
      }
      if (message.kind === "details" || message.kind === "released") {
        return;
      }
      if (
        attached.active?.requestId !== message.requestId ||
        attached.active.setId !== message.setId
      ) {
        return;
      }
      const [current] = this.ctx.storage.sql
        .exec<{ state: string }>(
          "SELECT download_state AS state FROM sets WHERE id = ?",
          message.setId
        )
        .toArray();
      if (current?.state !== "downloading") {
        return;
      }
      if (message.kind === "progress") {
        socket.serializeAttachment({
          ...GroupAudioNode.attachment(socket),
          progress: { received: message.received, total: message.total },
        } satisfies Attachment);
        return;
      }
      await this.runtime.runPromise(
        Effect.gen(function* completeCurrentRun() {
          const db = yield* Database;
          const library = yield* Library;
          yield* db.transaction((tx) =>
            Effect.gen(function* completeIfRunning() {
              const [set] = yield* tx.all<{ state: string }>(
                sql`SELECT download_state AS state FROM sets WHERE id = ${message.setId}`
              );
              if (set?.state !== "downloading") {
                return;
              }
              yield* message.kind === "finished"
                ? library.finishDownload(message.setId, message)
                : library.failDownload(message.setId);
            })
          );
        })
      );
      // The node logs the failure as an error; here it is the Group's view of it.
      logEvent(
        message.kind === "failed" ? "warn" : "info",
        {
          event: "group-download-settled",
          outcome: message.kind,
          requestId: message.requestId,
          set: message.setId,
        },
        this.logging
      );
      socket.serializeAttachment({
        ...GroupAudioNode.attachment(socket),
        active: null,
        progress: null,
      } satisfies Attachment);
      await this.runtime.runPromise(
        Effect.flatMap(Library, (library) => library.release(message.setId))
      );
      await this.schedule();
    });
  }

  private async reconcile(
    socket: WebSocket,
    files: Extract<NodeMessage, { kind: "inventory" }>["files"]
  ) {
    const ids = new Set(files.map((file) => file.setId));
    this.ctx.storage.transactionSync(() => {
      const ready = this.ctx.storage.sql
        .exec<{ id: string }>(
          "SELECT id FROM sets WHERE download_state = 'ready'"
        )
        .toArray();
      for (const set of ready) {
        if (!ids.has(set.id)) {
          this.ctx.storage.sql.exec(
            "UPDATE sets SET download_state = 'none', retained_audio_bytes = NULL, retained_audio_format = NULL WHERE id = ?",
            set.id
          );
        }
      }
    });
    // Reconciliation finishes each database change before dispatching the next
    // command, so each file is settled before the next is looked at.
    const reconcileFile = async (rest: typeof files): Promise<void> => {
      const [file, ...remaining] = rest;
      if (file === undefined) {
        return;
      }
      const [state] = this.ctx.storage.sql
        .exec<{ state: string; referenced: number }>(
          `SELECT download_state AS state, EXISTS(SELECT 1 FROM library_entries WHERE set_id = sets.id UNION ALL SELECT 1 FROM playlist_sets WHERE set_id = sets.id UNION ALL SELECT 1 FROM queue_entries WHERE set_id = sets.id) AS referenced FROM sets WHERE id = ?`,
          file.setId
        )
        .toArray();
      if (
        !state?.referenced ||
        !["ready", "downloading", "queued"].includes(state.state)
      ) {
        GroupAudioNode.send(socket, {
          kind: "release",
          requestId: crypto.randomUUID(),
          setId: file.setId,
        });
      } else if (state.state !== "ready") {
        await this.runtime.runPromise(
          Effect.flatMap(Library, (library) =>
            library.finishDownload(file.setId, file)
          )
        );
      }
      await reconcileFile(remaining);
    };
    await reconcileFile(files);
    await this.runtime.runPromise(
      Library.pipe(Effect.flatMap((library) => library.resetStuckDownloads))
    );
  }
}
