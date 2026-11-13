import { readFile } from "node:fs/promises";
import path from "node:path";

import type { SetAnalysis } from "@orbis/contracts";
import { SetAnalysisSchema } from "@orbis/contracts/http-api";
import { Schema } from "effect";

import { startJobLog } from "./logging.js";
import type { LoggingOptions } from "./logging.js";

const decodeAnalysis = Schema.decodeUnknownSync(
  Schema.fromJsonString(SetAnalysisSchema)
);

/** A 3-hour Set takes about 30 minutes at nice 19 on a busy Vanta; this leaves room for more load. */
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Where the node keeps a Set's analysis: beside its audio, so a release removes both. */
export const analysisPath = (audioDir: string, setId: string) =>
  path.join(audioDir, `${setId}.analysis.json`);

/** The Set's stored analysis, or undefined when it has none or the file is unreadable. */
export const readStoredAnalysis = async (
  audioDir: string,
  setId: string
): Promise<SetAnalysis | undefined> => {
  try {
    return decodeAnalysis(
      await readFile(analysisPath(audioDir, setId), "utf-8")
    );
  } catch {
    return undefined;
  }
};

export interface AudioAnalysisOptions {
  readonly audioDir: string;
  /** The `orbis-analyze` program (deploy/orbis-server/README.md says how to install it). */
  readonly bin: string;
  readonly logging?: LoggingOptions | undefined;
  readonly report: (setId: string, analysis: SetAnalysis) => void;
  readonly timeoutMs?: number;
}

/**
 * Runs `orbis-analyze` on each finished Download, one at a time, at nice 19. Each run logs one
 * `job: audio-analysis` event. A failure or timeout ends there: the Download has already finished,
 * and nothing here changes it.
 */
export const makeAudioAnalysis = (options: AudioAnalysisOptions) => {
  let tail = Promise.resolve();
  let running: Bun.Subprocess | undefined;
  let closed = false;
  /** One run of `orbis-analyze`: the analysis it wrote, or the reason it has none. */
  const analyse = async (
    setId: string,
    audioPath: string
  ): Promise<SetAnalysis | Error | "cancelled"> => {
    let timedOut = false;
    const proc = Bun.spawn(
      [
        "nice",
        "-n",
        "19",
        options.bin,
        audioPath,
        analysisPath(options.audioDir, setId),
      ],
      { stderr: "pipe", stdout: "ignore" }
    );
    running = proc;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const [code, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stderr).text(),
      ]);
      if (closed) {
        return "cancelled";
      }
      if (timedOut) {
        return new Error("orbis-analyze timed out.");
      }
      if (code !== 0) {
        const last = stderr.trim().split("\n").at(-1) ?? "";
        return new Error(`orbis-analyze exited ${code}: ${last.slice(0, 300)}`);
      }
      return (
        (await readStoredAnalysis(options.audioDir, setId)) ??
        new Error("orbis-analyze wrote no readable analysis.")
      );
    } finally {
      clearTimeout(timer);
      running = undefined;
    }
  };
  const run = async (setId: string, audioPath: string) => {
    if (closed) {
      return;
    }
    const job = startJobLog(
      { job: "audio-analysis", set: setId },
      options.logging
    );
    const startedAt = Date.now();
    let outcome: SetAnalysis | Error | "cancelled";
    try {
      outcome = await analyse(setId, audioPath);
    } catch (error) {
      outcome = error instanceof Error ? error : new Error(String(error));
    }
    job.annotate({ seconds: Math.round((Date.now() - startedAt) / 1000) });
    if (outcome === "cancelled") {
      job.finish("cancelled");
      return;
    }
    if (outcome instanceof Error) {
      job.finish("failure", outcome);
      return;
    }
    job.annotate({
      medianBpm: outcome.medianBpm,
      sections: outcome.sections.length,
    });
    job.finish("success");
    options.report(setId, outcome);
  };
  return {
    /** Stops the running analysis and waits for the queue to settle. */
    close: async () => {
      closed = true;
      running?.kill();
      await tail;
    },
    queue: (setId: string, audioPath: string) => {
      tail = (async () => {
        await tail;
        await run(setId, audioPath);
      })();
    },
  };
};
