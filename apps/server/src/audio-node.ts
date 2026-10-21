import { rm } from "node:fs/promises";

/* oxlint-disable no-await-in-loop -- Download backends run in fallback order against one partial file. */
import type { NodeCommand, NodeMessage } from "@orbis/contracts/node";
import { NodeCommandSchema, NodeMessageSchema } from "@orbis/contracts/node";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";

import { Cobalt } from "./cobalt.js";
import type { CobaltOptions } from "./cobalt.js";
import { DownloadBackends } from "./download-backends.js";
import { describeCause, logEvent, startJobLog } from "./logging.js";
import type { LoggedRecord, LoggingOptions } from "./logging.js";
import { MediaStore } from "./media-store.js";
import type { MediaStoreOptions } from "./media-store.js";
import { ytDlpMetadata } from "./ytdlp-metadata.js";
import { Ytdlp } from "./ytdlp.js";
import type { YtdlpOptions } from "./ytdlp.js";

export interface AudioNodeOptions
  extends CobaltOptions, MediaStoreOptions, YtdlpOptions {
  readonly groupUrl: string;
  readonly heartbeatMs?: number;
  readonly logging?: LoggingOptions;
  readonly nodeKey: string;
  readonly reconnectDelayMs?: number;
}

/**
 * Reconnects that fail this many times in a row, about 15 seconds at the default
 * delay, mean the link is down rather than restarting, so they log as errors.
 */
const FAILING_RECONNECT_ATTEMPT = 5;

export const startAudioNode = async (options: AudioNodeOptions) => {
  const mediaLayer = MediaStore.layer(options);
  const runtime = ManagedRuntime.make(
    DownloadBackends.layer.pipe(
      Layer.provide(Cobalt.layer(options)),
      Layer.provide(Ytdlp.layer(options)),
      Layer.provideMerge(mediaLayer)
    )
  );
  const media = await runtime.runPromise(MediaStore);
  const backends = await runtime.runPromise(DownloadBackends);
  await runtime.runPromise(media.ensureDirectory());
  const metadata = options.ytdlpBin
    ? ytDlpMetadata({ binPath: options.ytdlpBin })
    : undefined;
  let closed = false;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let active:
    | {
        command: Extract<NodeCommand, { kind: "start" }>;
        abort: AbortController;
        done: Promise<void>;
      }
    | undefined;
  let controls = Promise.resolve();
  const completed = new Map<string, NodeMessage>();
  const pending = new Map<string, Promise<void>>();
  const send = (message: NodeMessage) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };
  const finish = (command: NodeCommand, message: NodeMessage) => {
    completed.set(`${command.kind}:${command.requestId}`, message);
    const oldest = completed.keys().next().value;
    if (completed.size > 256 && oldest) {
      completed.delete(oldest);
    }
    send(message);
  };
  const stopDownload = async (setId?: string, requestId?: string) => {
    const current = active;
    if (
      current &&
      (!setId || current.command.setId === setId) &&
      (!requestId || current.command.requestId === requestId)
    ) {
      current.abort.abort();
      await current.done;
    }
  };
  const download = async (
    command: Extract<NodeCommand, { kind: "start" }>,
    signal: AbortSignal
  ) => {
    const { setId, requestId } = command;
    const tmp = media.partialPath(setId);
    // The Group's request id rides along, so one search follows a download across both.
    const job = startJobLog(
      { job: "audio-download", requestId, set: setId, source: command.source },
      options.logging
    );
    const attempts: LoggedRecord[] = [];
    let outcome: "success" | "failure" | "cancelled" = "cancelled";
    let failure: Error | undefined;
    try {
      const inventory = await runtime.runPromise(media.inventory(setId));
      const existing = inventory.find((file) => file.setId === setId);
      if (existing) {
        const message = Schema.decodeUnknownSync(NodeMessageSchema)({
          ...existing,
          kind: "finished",
          requestId,
        });
        job.annotate({ existing: true });
        outcome = "success";
        finish(command, message);
        return;
      }
      let lastError = new Error("No download backend is configured.");
      let fetched = false;
      for (const backend of backends.forSource(command.source)) {
        if (signal.aborted) {
          break;
        }
        await rm(tmp, { force: true });
        try {
          await runtime.runPromise(
            job.within(
              backends.fetch(
                backend,
                command.url,
                tmp,
                (received, total) => {
                  if (!signal.aborted) {
                    send({
                      kind: "progress",
                      received,
                      requestId,
                      setId,
                      total,
                    });
                  }
                },
                signal
              )
            )
          );
          attempts.push({ backend, ok: true });
          job.annotate({ backend });
          fetched = true;
          break;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (signal.aborted) {
            break;
          }
          attempts.push({
            backend,
            ok: false,
            reason: describeCause(lastError).message,
          });
        }
      }
      if (!fetched) {
        throw lastError;
      }
      if (signal.aborted) {
        return;
      }
      const stored = await runtime.runPromise(
        job.within(media.storeDownloaded(setId, tmp))
      );
      if (signal.aborted) {
        await runtime.runPromise(media.removeFiles(setId));
        return;
      }
      outcome = "success";
      finish(
        command,
        Schema.decodeUnknownSync(NodeMessageSchema)({
          kind: "finished",
          requestId,
          setId,
          ...stored,
        })
      );
    } catch (error) {
      if (!signal.aborted) {
        outcome = "failure";
        failure = error instanceof Error ? error : new Error(String(error));
        finish(command, {
          kind: "failed",
          reason: failure.message,
          requestId,
          setId,
        });
      }
    } finally {
      await rm(tmp, { force: true });
      job.annotate({ attempts });
      job.finish(outcome, failure);
    }
  };
  const handle = async (command: NodeCommand) => {
    const key = `${command.kind}:${command.requestId}`;
    const previous = completed.get(key);
    if (previous) {
      send(previous);
      return;
    }
    const { setId, requestId } = command;
    switch (command.kind) {
      case "start": {
        if (active?.command.requestId === requestId) {
          return;
        }
        await stopDownload();
        if (closed || socket?.readyState !== WebSocket.OPEN) {
          return;
        }
        const abort = new AbortController();
        const done = (async () => {
          try {
            await download(command, abort.signal);
          } catch {
            socket?.close();
          } finally {
            if (active?.command.requestId === requestId) {
              active = undefined;
            }
          }
        })();
        active = { abort, command, done };
        return;
      }
      case "cancel": {
        await stopDownload(setId, requestId);
        await runtime.runPromise(media.removeFiles(setId));
        finish(command, { kind: "released", requestId, setId });
        return;
      }
      case "release": {
        await stopDownload(setId);
        await runtime.runPromise(media.removeFiles(setId));
        finish(command, { kind: "released", requestId, setId });
        return;
      }
      case "read-details": {
        try {
          if (!metadata) {
            throw new Error("yt-dlp is not configured.");
          }
          const details = await Effect.runPromise(metadata.read(command.url));
          finish(command, { details, kind: "details", requestId, setId });
        } catch (error) {
          finish(command, {
            kind: "failed",
            reason: error instanceof Error ? error.message : String(error),
            requestId,
            setId,
          });
        }
        return;
      }
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  };
  const connect = () => {
    if (closed) {
      return;
    }
    // SAFETY: Bun implements this headers overload; lib.dom only declares the browser overload.
    const BunSocket = WebSocket as typeof WebSocket & {
      new (url: string, options: Bun.WebSocketOptions): WebSocket;
    };
    const current = new BunSocket(options.groupUrl, {
      headers: { authorization: `Bearer ${options.nodeKey}` },
    });
    socket = current;
    // The Group can lose this socket without a close ever reaching the node, so
    // an unanswered ping is the only sign the link is gone.
    let awaitingPong = false;
    let heartbeatTimedOut = false;
    let opened = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    current.addEventListener("open", async () => {
      opened = true;
      heartbeat = setInterval(() => {
        if (awaitingPong) {
          heartbeatTimedOut = true;
          current.close(4000, "Heartbeat timed out");
          return;
        }
        awaitingPong = true;
        current.send("ping");
      }, options.heartbeatMs ?? 30_000);
      try {
        const files = await runtime.runPromise(media.inventory());
        if (socket !== current || closed) {
          return;
        }
        send(
          Schema.decodeUnknownSync(NodeMessageSchema)({
            files,
            kind: "inventory",
          })
        );
        logEvent(
          "info",
          { attempt, event: "node-link-connected", files: files.length },
          options.logging
        );
        attempt = 0;
      } catch {
        current.close();
      }
    });
    current.addEventListener("message", (event) => {
      if (event.data === "pong") {
        awaitingPong = false;
        return;
      }
      try {
        const command = Schema.decodeUnknownSync(NodeCommandSchema)(
          JSON.parse(String(event.data))
        );
        const key = `${command.kind}:${command.requestId}`;
        if (pending.has(key)) {
          return;
        }
        const preceding = controls;
        const work = (async () => {
          try {
            if (command.kind !== "read-details") {
              await preceding;
            }
            await handle(command);
          } catch {
            current.close();
          } finally {
            pending.delete(key);
          }
        })();
        if (command.kind !== "read-details") {
          controls = work;
        }
        pending.set(key, work);
      } catch {
        current.close(1008, "Invalid node command");
      }
    });
    current.addEventListener("error", () => current.close());
    current.addEventListener("close", async (event) => {
      clearInterval(heartbeat);
      // A connect that never opened is reported by the reconnect that follows it.
      if (opened) {
        logEvent(
          closed ? "info" : "warn",
          {
            code: event.code,
            event: "node-link-closed",
            heartbeatTimedOut,
            reason: event.reason,
          },
          options.logging
        );
      }
      await stopDownload();
      await Promise.allSettled(pending.values());
      if (closed) {
        return;
      }
      const delay = Math.min(
        30_000,
        (options.reconnectDelayMs ?? 500) * 2 ** Math.min(attempt, 6)
      );
      attempt += 1;
      logEvent(
        attempt >= FAILING_RECONNECT_ATTEMPT ? "error" : "info",
        {
          attempt,
          connectFailed: opened ? null : `${event.code} ${event.reason}`.trim(),
          delayMs: delay,
          event: "node-link-reconnecting",
        },
        options.logging
      );
      retry = setTimeout(connect, delay);
    });
  };
  connect();
  return {
    close: async () => {
      closed = true;
      clearTimeout(retry);
      socket?.close();
      await stopDownload();
      await Promise.allSettled(pending.values());
      await runtime.dispose();
    },
  };
};
