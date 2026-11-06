import { Effect, Layer } from "effect";

import { Audio } from "../../server/src/audio-service.js";
import { LibraryError } from "../../server/src/errors.js";
import { Library } from "../../server/src/library.js";
import type { GroupAudioNode } from "./node.js";

export const makeAudioLayer = (node?: GroupAudioNode) =>
  Layer.succeed(Audio, {
    audioFile: Effect.fn("Audio.audioFile")(function* audioFile(id: string) {
      const library = yield* Library;
      const set = yield* library.find(id);
      if (set.downloadState !== "ready" || !set.retainedAudioFormat) {
        return yield* new LibraryError({
          message: "This set has no audio yet.",
          statusCode: 404,
        });
      }
      return {
        bytes: set.retainedAudioBytes ?? 0,
        contentType: "application/octet-stream",
        path: id,
      };
    }),
    audioState: Effect.fn("Audio.audioState")(function* audioState(id: string) {
      const library = yield* Library;
      const set = yield* library.find(id);
      const live = node?.progressFor(id);
      return {
        bytesReceived: live?.received ?? set.retainedAudioBytes ?? 0,
        bytesTotal: live?.total ?? set.retainedAudioBytes,
        format: set.retainedAudioFormat,
        state: set.downloadState,
      };
    }),
    cancelDownload: Effect.fn("Audio.cancelDownload")(function* cancelDownload(
      id: string
    ) {
      const library = yield* Library;
      const set = yield* library.cancelDownload(id);
      if (node) {
        yield* Effect.promise(async () => {
          await node.cancel(id);
        });
      }
      return set;
    }),
    isConfigured: true,
    processNext: Effect.succeed(false),
    requestDownload: Effect.fn("Audio.requestDownload")(function* queueDownload(
      id: string
    ) {
      const library = yield* Library;
      const current = yield* library.find(id);
      if (!["none", "failed", "canceled"].includes(current.downloadState)) {
        return { accepted: false, set: current };
      }
      const set = yield* library.queueDownload(id);
      if (node) {
        yield* Effect.promise(async () => {
          await node.wake();
        });
      }
      return { accepted: true, set };
    }),
  });

export const audioLayer = makeAudioLayer();
