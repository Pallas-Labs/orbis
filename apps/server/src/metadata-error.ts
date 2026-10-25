import { Schema } from "effect";

// TaggedError is a curried schema factory, not an Error constructor.
const { TaggedError: taggedFailure } = Schema;

export const MetadataReason = Schema.Literals([
  "not-configured",
  /** The provider answered that it has no such item, as Apple does for an album outside its catalog. */
  "not-found",
  "provider-rejected",
  "provider-unavailable",
  "unexpected-response",
  "unsupported-source",
]);

export class MetadataError extends taggedFailure<MetadataError>()(
  "MetadataError",
  {
    message: Schema.String,
    reason: MetadataReason,
  }
) {}
