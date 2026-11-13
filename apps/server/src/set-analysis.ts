import type { SetAnalysis } from "@orbis/contracts";
import { SetAnalysisSchema } from "@orbis/contracts/http-api";
import { eq } from "drizzle-orm";
import { Effect, Schema } from "effect";

import { setAnalysis, sets } from "./db/schema.js";
import { Database } from "./db/service.js";

const decodeStored = Schema.decodeUnknownOption(
  Schema.fromJsonString(SetAnalysisSchema)
);

export type SetAnalysisOutcome = "stored" | "unchanged" | "unknown-set";

/** The Set's stored analysis, or null when the node has not measured it yet. */
export const readSetAnalysis = Effect.fn("SetAnalysis.read")(
  function* readSetAnalysis(id: string) {
    const db = yield* Database;
    const [row] = yield* db
      .select({ analysis: setAnalysis.analysis })
      .from(setAnalysis)
      .where(eq(setAnalysis.setId, id))
      .limit(1);
    if (row === undefined) {
      return null;
    }
    // A row this version cannot read is no analysis, so the Set page still opens.
    const decoded = decodeStored(row.analysis);
    return decoded._tag === "Some" ? decoded.value : null;
  }
);

/**
 * Store the Set's analysis, replacing any earlier one. The node sends every stored analysis on each
 * connect, so an analysis equal to the stored one writes nothing and answers `unchanged`. A Set the
 * Group does not know answers `unknown-set`: the node keeps files for Sets the Group may have forgotten.
 */
export const storeSetAnalysis = Effect.fn("SetAnalysis.store")(
  function* storeSetAnalysis(id: string, analysis: SetAnalysis) {
    const db = yield* Database;
    const [set] = yield* db
      .select({ id: sets.id, stored: setAnalysis.analysis })
      .from(sets)
      .leftJoin(setAnalysis, eq(setAnalysis.setId, sets.id))
      .where(eq(sets.id, id))
      .limit(1);
    if (set === undefined) {
      return "unknown-set" as const;
    }
    const row = {
      analysis: JSON.stringify(analysis),
      setId: id,
      updatedAt: new Date().toISOString(),
    };
    if (set.stored === row.analysis) {
      return "unchanged" as const;
    }
    yield* db
      .insert(setAnalysis)
      .values(row)
      .onConflictDoUpdate({
        set: { analysis: row.analysis, updatedAt: row.updatedAt },
        target: setAnalysis.setId,
      });
    return "stored" as const;
  }
);
