import { Schema } from "effect";

const SafeInteger = Schema.Int;
const Sequence = SafeInteger.check(Schema.isGreaterThanOrEqualTo(0));
const Finite = Schema.NullOr(Schema.Finite);
const State = Schema.Literals([
  "idle",
  "loading",
  "playing",
  "paused",
  "interrupted",
  "failed",
]);
const WaitingReason = Schema.Literals([
  "none",
  "minimizingStalls",
  "evaluatingBufferingRate",
  "noItem",
  "interstitial",
  "other",
]);
const ErrorValue = Schema.Struct({
  code: SafeInteger,
  domain: Schema.Literals([
    "url",
    "avFoundation",
    "coreMedia",
    "osStatus",
    "other",
  ]),
});
const Access = Schema.Struct({
  bytesTransferred: SafeInteger,
  downloadedDuration: Finite,
  indicatedBitrate: Finite,
  observedBitrate: Finite,
  stalls: SafeInteger,
  transferDuration: Finite,
});
const Snapshot = Schema.Struct({
  access: Schema.optionalKey(Access),
  actualTime: Finite,
  bufferEmpty: Schema.Boolean,
  bufferFull: Schema.Boolean,
  bufferRanges: Schema.Array(
    Schema.Struct({ duration: Finite, start: Finite })
  ).check(Schema.isMaxLength(8)),
  displayedTime: Finite,
  duration: Finite,
  itemState: Schema.Literals(["none", "unknown", "ready", "failed"]),
  likelyToKeepUp: Schema.Boolean,
  pendingSeek: Finite,
  playbackGeneration: Sequence,
  rate: Finite,
  seekID: Sequence,
  seekInFlight: Schema.Boolean,
  sessionReady: Schema.Boolean,
  state: State,
  waitingReason: WaitingReason,
});
const Empty = Schema.Record(Schema.String, Schema.Never);
const Event = Schema.Union([
  Schema.Struct({
    command: Schema.Struct({
      _0: Schema.Struct({
        kind: Schema.Literals([
          "play",
          "pause",
          "toggle",
          "seek",
          "nextCue",
          "previousCue",
          "skipForward",
          "skipBackward",
          "stop",
        ]),
        origin: Schema.Literals([
          "app",
          "systemRemote",
          "internalOperation",
          "unknown",
        ]),
        target: Finite,
      }),
    }),
  }),
  Schema.Struct({
    state: Schema.Struct({ _0: Schema.Struct({ from: State, to: State }) }),
  }),
  Schema.Struct({
    seekResult: Schema.Struct({
      _0: Schema.Struct({
        actual: Finite,
        duration: Finite,
        finished: Schema.Boolean,
        seekID: Sequence,
        target: Finite,
      }),
    }),
  }),
  Schema.Struct({ sample: Empty }),
  Schema.Struct({
    waiting: Schema.Struct({ _0: Schema.Struct({ reason: WaitingReason }) }),
  }),
  Schema.Struct({ stalled: Empty }),
  Schema.Struct({
    discontinuity: Schema.Struct({
      _0: Schema.Struct({
        gap: Finite,
        mediaDelta: Finite,
        rate: Finite,
        wallDelta: Finite,
      }),
    }),
  }),
  Schema.Struct({
    timeJumped: Schema.Struct({
      _0: Schema.Struct({
        actual: Finite,
        seekID: Schema.optionalKey(Sequence),
      }),
    }),
  }),
  Schema.Struct({
    buffer: Schema.Struct({
      _0: Schema.Struct({
        reason: Schema.Literals(["ready", "waiting", "stalled"]),
      }),
    }),
  }),
  Schema.Struct({
    access: Schema.Struct({ _0: Schema.Struct({ metrics: Access }) }),
  }),
  Schema.Struct({
    session: Schema.Struct({
      _0: Schema.Struct({
        phase: Schema.Literals([
          "startRequested",
          "ready",
          "failed",
          "endRequested",
          "ended",
        ]),
        playbackGeneration: Sequence,
        requestID: Sequence,
      }),
    }),
  }),
  Schema.Struct({
    item: Schema.Struct({
      _0: Schema.Struct({
        error: Schema.optionalKey(ErrorValue),
        phase: Schema.Literals(["installed", "ready", "failed"]),
      }),
    }),
  }),
  Schema.Struct({
    ended: Schema.Struct({
      _0: Schema.Struct({
        actual: Finite,
        expected: Finite,
        premature: Schema.Boolean,
      }),
    }),
  }),
  Schema.Struct({
    interruption: Schema.Struct({
      _0: Schema.Struct({
        phase: Schema.Literals(["began", "ended"]),
        shouldResume: Schema.Boolean,
      }),
    }),
  }),
  Schema.Struct({
    route: Schema.Struct({
      _0: Schema.Struct({
        reason: Schema.Literals(["oldDeviceUnavailable", "other"]),
      }),
    }),
  }),
  Schema.Struct({ reset: Empty }),
  Schema.Struct({
    activation: Schema.Struct({
      _0: Schema.Struct({
        generation: Sequence,
        phase: Schema.Literals([
          "began",
          "intentChanged",
          "accepted",
          "superseded",
          "failed",
          "cancelled",
        ]),
        requestDuration: Finite,
        target: Finite,
        wantsSound: Schema.Boolean,
      }),
    }),
  }),
  Schema.Struct({ error: Schema.Struct({ _0: ErrorValue }) }),
]);
const MetadataString = Schema.String.check(Schema.isMaxLength(64));
export const PlaybackDiagnosticsBatch = Schema.Struct({
  afterSequence: Sequence,
  entries: Schema.Array(
    Schema.Struct({
      event: Event,
      sequence: Sequence.check(Schema.isGreaterThan(0)),
      snapshot: Snapshot,
      uptime: Finite,
      wallTime: Schema.Finite.check(
        Schema.isBetween({ maximum: 18_446_744_073_709, minimum: 0 })
      ),
    })
  ).check(Schema.isMaxLength(32)),
  metadata: Schema.Struct({
    appBuild: MetadataString,
    appVersion: MetadataString,
    osName: MetadataString,
    osVersion: MetadataString,
  }),
  runId: Schema.String.check(
    Schema.isPattern(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
    )
  ),
  schemaVersion: Schema.Literal(1),
  throughSequence: Sequence,
}).check(
  Schema.makeFilter((batch) => {
    if (batch.throughSequence <= batch.afterSequence) {
      return false;
    }
    let previous = batch.afterSequence;
    for (const entry of batch.entries) {
      if (
        entry.sequence <= previous ||
        entry.sequence > batch.throughSequence
      ) {
        return false;
      }
      previous = entry.sequence;
    }
    return true;
  })
);
export type PlaybackDiagnosticsPayload = typeof PlaybackDiagnosticsBatch.Type;
export const PlaybackDiagnosticsReceipt = Schema.Struct({
  accepted: Sequence,
  rejected: Sequence,
});

export const decodePlaybackDiagnosticsBatch = Schema.decodeUnknownSync(
  PlaybackDiagnosticsBatch,
  { onExcessProperty: "error" }
);
