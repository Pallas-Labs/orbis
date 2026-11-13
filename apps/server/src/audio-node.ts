import { rm } from "node:fs/promises";
import path from "node:path";

import type { NodeCommand, NodeMessage } from "@orbis/contracts/node";
import { NodeCommandSchema, NodeMessageSchema } from "@orbis/contracts/node";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";

import { makeAudioAnalysis, readStoredAnalysis } from "./audio-analysis.js";
import { Cobalt } from "./cobalt.js";
import type { CobaltOptions } from "./cobalt.js";
import { DownloadBackends } from "./download-backends.js";
import type { BackendName } from "./download-backends.js";
import {
  describeCause,
  logEvent,
  loggingLayer,
  startJobLog,
} from "./logging.js";
import type { LoggedRecord, LoggingOptions } from "./logging.js";
import { MediaStore } from "./media-store.js";
import type { MediaStoreOptions } from "./media-store.js";
import { ytDlpMetadata } from "./ytdlp-metadata.js";
import { Ytdlp } from "./ytdlp.js";
import type { YtdlpOptions } from "./ytdlp.js";

const decodeNodeCommand = Schema.decodeUnknownSync(NodeCommandSchema);

const decodeNodeMessage = Schema.decodeUnknownSync(NodeMessageSchema);

export interface AudioNodeOptions
  extends CobaltOptions, MediaStoreOptions, YtdlpOptions {
  /** `orbis-analyze`; without it the node measures no Set. */
  readonly analyzeBin?: string | undefined;
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
      Layer.provideMerge(mediaLayer),
      // Startup lines, such as a source with one backend, go out as events too.
      Layer.provideMerge(loggingLayer)
    )
  );
  const media = await runtime.runPromise(MediaStore);
  const backends = await runtime.runPromise(DownloadBackends);
  await runtime.runPromise(media.ensureDirectory);
  const metadata =
    options.ytdlpBin !== undefined && options.ytdlpBin !== ""
      ? ytDlpMetadata({ binPath: options.ytdlpBin })
      : undefined;
  let closed = false;
  let socket: WebSocket | undefined;
  /** Whether the current socket has sent its inventory; the Group closes a link that sends work first. */
  let inventorySent = false;
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
  const audioDir = options.audioDir ?? path.join(".", "audio");
  // A report made while the link is down, or before its inventory, is dropped. The file stays, and
  // the stored analyses sent after the inventory include it.
  const analysis =
    options.analyzeBin !== undefined && options.analyzeBin !== ""
      ? makeAudioAnalysis({
          audioDir,
          bin: options.analyzeBin,
          logging: options.logging,
          report: (setId, measured) => {
            if (inventorySent) {
              send({ analysis: measured, kind: "analysis", setId });
            }
          },
        })
      : undefined;
  const finish = (command: NodeCommand, message: NodeMessage) => {
    completed.set(`${command.kind}:${command.requestId}`, message);
    const oldest = completed.keys().next().value;
    if (completed.size > 256 && oldest !== undefined) {
      completed.delete(oldest);
    }
    send(message);
  };
  const stopDownload = async (setId?: string, requestId?: string) => {
    const current = active;
    if (
      current &&
      (setId === undefined || current.command.setId === setId) &&
      (requestId === undefined || current.command.requestId === requestId)
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
        const message = decodeNodeMessage({
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
      // The backends run in fallback order against one partial file, so each
      // attempt finishes before the next starts.
      const attemptBackend = async (
        rest: readonly BackendName[]
      ): Promise<void> => {
        const [backend, ...remaining] = rest;
        if (backend === undefined || signal.aborted) {
          return;
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
          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (signal.aborted) {
            return;
          }
          attempts.push({
            backend,
            ok: false,
            reason: describeCause(lastError).message,
          });
        }
        await attemptBackend(remaining);
      };
      await attemptBackend(backends.forSource(command.source));
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
        decodeNodeMessage({
          kind: "finished",
          requestId,
          setId,
          ...stored,
        })
      );
      analysis?.queue(setId, media.fileFor(setId, stored.format));
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
        // A new Download replaces the Set's audio, so an analysis of the old file must not report.
        await analysis?.cancel(setId);
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
        await analysis?.cancel(setId);
        await runtime.runPromise(media.removeFiles(setId));
        finish(command, { kind: "released", requestId, setId });
        return;
      }
      case "release": {
        await stopDownload(setId);
        await analysis?.cancel(setId);
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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see the SAFETY comment above.
    const BunSocket = WebSocket as typeof WebSocket & {
      new (url: string, options: Bun.WebSocketOptions): WebSocket;
    };
    const current = new BunSocket(options.groupUrl, {
      headers: { authorization: `Bearer ${options.nodeKey}` },
    });
    socket = current;
    inventorySent = false;
    // The Group can lose this socket without a close ever reaching the node, so
    // an unanswered ping is the only sign the link is gone.
    let awaitingPong = false;
    let heartbeatTimedOut = false;
    let opened = false;
    let openedAt = 0;
    // A long silence before a close points at an idle timeout; a short one, at a drop mid-traffic.
    let lastMessageAt = 0;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const onOpen = async () => {
      opened = true;
      openedAt = Date.now();
      lastMessageAt = openedAt;
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
          decodeNodeMessage({
            files,
            kind: "inventory",
          })
        );
        inventorySent = true;
        logEvent(
          "info",
          { attempt, event: "node-link-connected", files: files.length },
          options.logging
        );
        attempt = 0;
        // Every stored analysis goes again on each connect: the Group stores the newest, and a
        // report the last link lost arrives this way.
        const reportStored = async (rest: typeof files): Promise<void> => {
          const [file, ...remaining] = rest;
          if (file === undefined || socket !== current || closed) {
            return;
          }
          const stored = await readStoredAnalysis(audioDir, file.setId);
          if (stored !== undefined) {
            send({ analysis: stored, kind: "analysis", setId: file.setId });
          }
          await reportStored(remaining);
        };
        await reportStored(files);
      } catch {
        current.close();
      }
    };
    current.addEventListener("open", () => {
      void onOpen();
    });
    current.addEventListener("message", (event) => {
      lastMessageAt = Date.now();
      if (event.data === "pong") {
        awaitingPong = false;
        return;
      }
      try {
        const command = decodeNodeCommand(JSON.parse(String(event.data)));
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
    current.addEventListener("error", () => {
      current.close();
    });
    const onClose = async (event: CloseEvent) => {
      clearInterval(heartbeat);
      // A connect that never opened is reported by the reconnect that follows it.
      if (opened) {
        const now = Date.now();
        logEvent(
          closed ? "info" : "warn",
          {
            ageMs: now - openedAt,
            code: event.code,
            event: "node-link-closed",
            heartbeatTimedOut,
            reason: event.reason,
            sinceMessageMs: now - lastMessageAt,
          },
          options.logging
        );
      }
      await stopDownload();
      // oxlint-disable-next-line orbis/bounded-concurrency -- waits for work already started; it starts nothing.
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
    };
    current.addEventListener("close", (event) => {
      void onClose(event);
    });
  };
  connect();
  return {
    close: async () => {
      closed = true;
      clearTimeout(retry);
      socket?.close();
      await stopDownload();
      await analysis?.close();
      // oxlint-disable-next-line orbis/bounded-concurrency -- waits for work already started; it starts nothing.
      await Promise.allSettled(pending.values());
      await runtime.dispose();
    },
  };
};
