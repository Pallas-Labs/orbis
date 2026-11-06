// Two chained Effect.provide calls: the Effect language service reports multipleEffectProvide at
// warning severity, and tsconfig.base.json makes a warning fail tsc. scripts/fence.test.mjs
// type-checks this file.
import { Effect, Layer } from "effect";

export const provided = Effect.void.pipe(
  Effect.provide(Layer.empty),
  Effect.provide(Layer.empty)
);
