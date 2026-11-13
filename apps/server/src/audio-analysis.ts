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

/** One queued analysis. `cancelled` stops it before it starts, or makes its run drop its result. */
interface AnalysisJob {
  readonly audioPath: string;
  cancelled: boolean;
  proc?: Bun.Subprocess | undefined;
  readonly setId: string;
  settled: Promise<void>;
  started: boolean;
}

/**
 * Runs `orbis-analyze` on each finished Download, one at a time, at nice 19. Each run logs one
 * `job: audio-analysis` event. A failure or timeout ends there: the Download has already finished,
 * and nothing here changes it. `cancel` stops a Set's analysis before its files go, so a release
 * never sees a report or an analysis file come back after it.
 */
export const makeAudioAnalysis = (options: AudioAnalysisOptions) => {
  let tail = Promise.resolve();
  let closed = false;
  const jobs = new Set<AnalysisJob>();
  /** One run of `orbis-analyze`: the analysis it wrote, or the reason it has none. */
  const analyse = async (
    job: AnalysisJob
  ): Promise<SetAnalysis | Error | "cancelled"> => {
    let timedOut = false;
    const proc = Bun.spawn(
      [
        "nice",
        "-n",
        "19",
        options.bin,
        job.audioPath,
        analysisPath(options.audioDir, job.setId),
      ],
      { stderr: "pipe", stdout: "ignore" }
    );
    job.proc = proc;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const [code, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stderr).text(),
      ]);
      if (job.cancelled) {
        return "cancelled";
      }
      if (timedOut) {
        return new Error("orbis-analyze timed out.");
      }
      if (code !== 0) {
        const last = stderr.trim().split("\n").at(-1) ?? "";
        return new Error(`orbis-analyze exited ${code}: ${last.slice(0, 300)}`);
      }
      const stored = await readStoredAnalysis(options.audioDir, job.setId);
      if (job.cancelled) {
        return "cancelled";
      }
      return stored ?? new Error("orbis-analyze wrote no readable analysis.");
    } finally {
      clearTimeout(timer);
      job.proc = undefined;
    }
  };
  // No await may come between the `cancelled` check and the spawn in `analyse`: `cancel` waits only
  // for a job that has started, and trusts any other job to see `cancelled` before it spawns.
  const run = async (job: AnalysisJob) => {
    if (job.cancelled) {
      return;
    }
    job.started = true;
    const log = startJobLog(
      { job: "audio-analysis", set: job.setId },
      options.logging
    );
    const startedAt = Date.now();
    let outcome: SetAnalysis | Error | "cancelled";
    try {
      outcome = await analyse(job);
    } catch (error) {
      outcome = error instanceof Error ? error : new Error(String(error));
    }
    log.annotate({ seconds: Math.round((Date.now() - startedAt) / 1000) });
    if (outcome === "cancelled" || job.cancelled) {
      log.finish("cancelled");
      return;
    }
    if (outcome instanceof Error) {
      log.finish("failure", outcome);
      return;
    }
    log.annotate({
      medianBpm: outcome.medianBpm,
      sections: outcome.sections.length,
    });
    log.finish("success");
    options.report(job.setId, outcome);
  };
  /** Stops each matching job: a queued one never starts, and the running one is killed and awaited. */
  const stop = async (matches: (job: AnalysisJob) => boolean) => {
    let running: AnalysisJob | undefined;
    for (const job of jobs) {
      if (matches(job)) {
        job.cancelled = true;
        job.proc?.kill();
        // The queue runs one job at a time, so at most one matching job has started.
        if (job.started) {
          running = job;
        }
      }
    }
    await running?.settled;
  };
  return {
    /**
     * Stops the Set's analysis and waits until its program has exited and its run has ended, so
     * the caller can remove the Set's files knowing nothing writes or reports them afterwards.
     */
    cancel: async (setId: string) => {
      await stop((job) => job.setId === setId);
    },
    /** Stops every analysis and waits for the queue to settle. */
    close: async () => {
      closed = true;
      await stop(() => true);
      await tail;
    },
    queue: (setId: string, audioPath: string) => {
      if (closed) {
        return;
      }
      const previous = tail;
      const job: AnalysisJob = {
        audioPath,
        cancelled: false,
        setId,
        settled: Promise.resolve(),
        started: false,
      };
      job.settled = (async () => {
        try {
          await previous;
          await run(job);
        } finally {
          jobs.delete(job);
        }
      })();
      jobs.add(job);
      tail = job.settled;
    },
  };
};
