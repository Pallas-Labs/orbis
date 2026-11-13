import { Schema } from "effect";

import { SetAnalysisSchema } from "./set-analysis.js";

const SetId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/u));
const Identity = { requestId: Schema.String, setId: SetId };
const Format = Schema.Literals(["mp3", "ogg", "m4a"]);
const NonNegative = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
const Audio = {
  bytes: NonNegative,
  durationSeconds: NonNegative,
  format: Format,
};
export const SourceDetails = Schema.Struct({
  chapters: Schema.Array(
    Schema.Struct({ startSeconds: NonNegative, title: Schema.String })
  ),
  creator: Schema.NullOr(Schema.String),
  creatorId: Schema.NullOr(Schema.String),
  creatorUrl: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  durationSeconds: Schema.NullOr(NonNegative),
  genre: Schema.NullOr(Schema.String),
  releasedAt: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
  thumbnailUrl: Schema.NullOr(Schema.String),
  title: Schema.String,
});
export const NodeCommandSchema = Schema.Union([
  Schema.Struct({
    ...Identity,
    kind: Schema.Literal("start"),
    source: Schema.Literals(["youtube", "soundcloud"]),
    url: Schema.String,
  }),
  Schema.Struct({ ...Identity, kind: Schema.Literal("cancel") }),
  Schema.Struct({
    ...Identity,
    kind: Schema.Literal("read-details"),
    url: Schema.String,
  }),
  Schema.Struct({ ...Identity, kind: Schema.Literal("release") }),
]);
export type NodeCommand = typeof NodeCommandSchema.Type;
export const NodeMessageSchema = Schema.Union([
  Schema.Struct({
    ...Identity,
    kind: Schema.Literal("progress"),
    received: NonNegative,
    total: Schema.NullOr(NonNegative),
  }),
  Schema.Struct({ ...Identity, ...Audio, kind: Schema.Literal("finished") }),
  Schema.Struct({
    ...Identity,
    kind: Schema.Literal("failed"),
    reason: Schema.String,
  }),
  Schema.Struct({
    ...Identity,
    details: SourceDetails,
    kind: Schema.Literal("details"),
  }),
  Schema.Struct({ ...Identity, kind: Schema.Literal("released") }),
  Schema.Struct({
    files: Schema.Array(Schema.Struct({ setId: SetId, ...Audio })),
    kind: Schema.Literal("inventory"),
  }),
  // Sent after a Download's analysis finishes, and after the inventory for every stored analysis.
  Schema.Struct({
    analysis: SetAnalysisSchema,
    kind: Schema.Literal("analysis"),
    setId: SetId,
  }),
]);
export type NodeMessage = typeof NodeMessageSchema.Type;
