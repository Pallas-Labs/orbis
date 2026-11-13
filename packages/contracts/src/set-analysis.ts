import { Schema } from "effect";

const Seconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
// 30 s windows over 16 hours: longer than any Set the node keeps.
const MAX_WINDOWS = 1920;
const MAX_SECTIONS = 64;

/**
 * A stretch of a Set that holds one tempo. The name says where it sits in the Set: "Locked in",
 * "Lift", "Peak", "Come down", "Close", or "Section N".
 */
export const SetSectionSchema = Schema.Struct({
  bpm: Schema.Finite,
  endSeconds: Seconds,
  name: Schema.String.check(Schema.isMaxLength(40)),
  startSeconds: Seconds,
});

/**
 * A Set's tempo and loudness, which the audio node measures from its Retained Audio
 * (`orbis-analyze`). Each curve point is a 30 s window starting at `seconds`. A window with no
 * steady beat, or a silent one, has no point. `medianBpm` is null when no window had a steady beat.
 */
export const SetAnalysisSchema = Schema.Struct({
  bpmCurve: Schema.Array(
    Schema.Struct({ bpm: Schema.Finite, seconds: Seconds })
  ).check(Schema.isMaxLength(MAX_WINDOWS)),
  durationSeconds: Seconds,
  integratedLufs: Schema.NullOr(Schema.Finite),
  loudnessCurve: Schema.Array(
    Schema.Struct({ lufs: Schema.Finite, seconds: Seconds })
  ).check(Schema.isMaxLength(MAX_WINDOWS)),
  medianBpm: Schema.NullOr(Schema.Finite),
  sections: Schema.Array(SetSectionSchema).check(
    Schema.isMaxLength(MAX_SECTIONS)
  ),
});
export type SetAnalysis = typeof SetAnalysisSchema.Type;
