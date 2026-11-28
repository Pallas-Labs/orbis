// Runs the TLA+ models in `apps/server/models` with everystate and draws their Mermaid
// statecharts. `bun apps/server/src/models.ts --write` rewrites the committed charts.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Schema } from "effect";

export const modelsDirectory = path.resolve(import.meta.dir, "../models");

/** The launcher everystate installs; it runs the native binary for this platform. */
const launcher = path.resolve(
  path.dirname(fileURLToPath(import.meta.resolve("everystate"))),
  "../bin/everystate.mjs"
);

export interface Run {
  readonly exitCode: number;
  readonly output: string;
}

/** Runs everystate with `args` in the models folder. */
export const everystate = (args: readonly string[]): Run => {
  const run = Bun.spawnSync([process.execPath, launcher, ...args], {
    cwd: modelsDirectory,
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: run.exitCode,
    output: `${run.stdout.toString()}${run.stderr.toString()}`,
  };
};

/** What a check of one configuration must report. */
export type Verdict =
  | { readonly status: "ok" }
  | { readonly status: "invariant"; readonly name: string };

export interface Check {
  readonly spec: string;
  readonly config: string;
  readonly expect: Verdict;
  /** Why the configuration exists, in one sentence. */
  readonly reason: string;
}

/** Every configuration CI checks, and the verdict it must keep. */
export const checks: readonly Check[] = [
  {
    config: "SetDownload",
    expect: { status: "ok" },
    reason: "The Download moves keep every rule.",
    spec: "SetDownload",
  },
  {
    config: "SetDownloadBroken",
    expect: { name: "ReadyHasAudio", status: "invariant" },
    reason:
      "Negative check: a finish that ignores a cancel or release that landed first.",
    spec: "SetDownload",
  },
  {
    config: "SetDownloadReleaseGap",
    expect: { name: "ReadyHasAudio", status: "invariant" },
    reason:
      "Known gap: an inventory pass between a finish and its release drops a ready file.",
    spec: "SetDownload",
  },
  {
    config: "PlaybackPosition",
    expect: { status: "ok" },
    reason:
      "On a network that delivers, a resume finds the other device's pause.",
    spec: "PlaybackPosition",
  },
  {
    config: "PlaybackPositionLossy",
    expect: { name: "HandoffResumes", status: "invariant" },
    reason:
      "Known gap: a pause saved while offline is dropped, so the handoff can miss.",
    spec: "PlaybackPosition",
  },
];

const exitCodeFor = (verdict: Verdict) => (verdict.status === "ok" ? 0 : 12);

export interface CheckResult {
  readonly exitCode: number;
  readonly expectedExitCode: number;
  readonly verdict:
    | Verdict
    | { readonly status: string; readonly name?: string };
  readonly distinct: number;
}

/** The last line `everystate -json` prints. */
const decodeResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      distinct: Schema.optionalKey(Schema.Finite),
      name: Schema.optionalKey(Schema.String),
      status: Schema.String,
    })
  )
);

/** Checks one configuration and reads everystate's JSON result. */
export const runCheck = (check: Check): CheckResult => {
  const run = everystate([
    "-json",
    "-config",
    `${check.config}.cfg`,
    `${check.spec}.tla`,
  ]);
  const result = decodeResult(run.output.trim().split("\n").at(-1) ?? "{}");
  return {
    distinct: result.distinct ?? 0,
    exitCode: run.exitCode,
    expectedExitCode: exitCodeFor(check.expect),
    verdict:
      result.name === undefined
        ? { status: result.status }
        : { name: result.name, status: result.status },
  };
};

/** One state of a dumped graph: each variable's value as TLA+ prints it. */
type Values = Readonly<Record<string, string>>;

export interface Chart {
  readonly spec: string;
  readonly config: string;
  readonly file: string;
  readonly title: string;
  /** The chart state a model state belongs to, in the reader's words. */
  readonly label: (values: Values) => string;
}

// A function value of one device, such as `(phone :> TRUE)`.
const ofPhone = (value: string | undefined) =>
  /:>\s*(?<value>.+)\)$/u.exec(value ?? "")?.groups?.value ?? "";

// Positions are 0..MaxPos, and MaxPos + 1 stands for no report (`None`).
const noReport = "2";

const reportStage = (values: Values) => {
  if (ofPhone(values.outbox) !== noReport) {
    return ", save on the way";
  }
  if (ofPhone(values.reply) !== noReport) {
    return ", answer on the way";
  }
  return "";
};

export const charts: readonly Chart[] = [
  {
    config: "SetDownload",
    file: "SetDownload.mmd",
    label: (values) => {
      const state = (values.state ?? "").replaceAll('"', "");
      return values.stored === "TRUE" ? `${state}, file on node` : state;
    },
    spec: "SetDownload",
    title: "A Set's Download and its file on the audio node",
  },
  {
    // One device's view: the chart is about the steps one device takes.
    config: "PlaybackPositionDevice",
    file: "PlaybackPosition.mmd",
    label: (values) => {
      const playing = ofPhone(values.playing) === "TRUE" ? "Playing" : "Paused";
      const offline = ofPhone(values.online) === "TRUE" ? "" : ", offline";
      return `${playing}${reportStage(values)}${offline}`;
    },
    spec: "PlaybackPosition",
    title: "One device's Playback Position reports",
  },
];

/** Reads a `-dump dot,actionlabels` graph: each state's values and each step. */
const readDot = (dot: string) => {
  const states = new Map<string, Values>();
  const steps: { from: string; to: string; action: string }[] = [];
  let initial: string | undefined;
  for (const line of dot.split("\n")) {
    const step =
      /^(?<from>-?\d+) -> (?<to>-?\d+) \[label="(?<action>[^"]+)"/u.exec(
        line
      )?.groups;
    if (step) {
      steps.push({
        action: step.action ?? "",
        from: step.from ?? "",
        to: step.to ?? "",
      });
      continue;
    }
    const node =
      /^(?<id>-?\d+) \[label="(?<label>.*)"(?<filled>,style = filled)?\]/u.exec(
        line
      )?.groups;
    if (node?.id !== undefined) {
      const values: Record<string, string> = {};
      for (const part of (node.label ?? "").split(String.raw`\n`)) {
        const pair = /^\/\\\\ (?<name>\w+) = (?<value>.*)$/u.exec(part)?.groups;
        if (pair?.name !== undefined && pair.value !== undefined) {
          values[pair.name] = pair.value.replaceAll(String.raw`\"`, '"');
        }
      }
      states.set(node.id, values);
      if (node.filled !== undefined) {
        initial ??= node.id;
      }
    }
  }
  return { initial, states, steps };
};

/** Draws a chart: one state per label, one arrow per pair of labels, steps that stay hidden. */
export const drawChart = (chart: Chart): string => {
  const folder = mkdtempSync(path.join(tmpdir(), "orbis-statechart-"));
  try {
    const dotFile = path.join(folder, "graph.dot");
    const run = everystate([
      "-dump",
      "dot,actionlabels",
      dotFile,
      "-config",
      `${chart.config}.cfg`,
      `${chart.spec}.tla`,
    ]);
    if (run.exitCode !== 0) {
      throw new Error(`everystate failed on ${chart.config}:\n${run.output}`);
    }
    const graph = readDot(readFileSync(dotFile, "utf-8"));
    const labelOf = (id: string) => chart.label(graph.states.get(id) ?? {});
    const arrows = new Map<string, Set<string>>();
    for (const step of graph.steps) {
      const from = labelOf(step.from);
      const to = labelOf(step.to);
      if (from !== to) {
        const key = `${from}\u0000${to}`;
        const actions = arrows.get(key) ?? new Set<string>();
        actions.add(step.action);
        arrows.set(key, actions);
      }
    }
    const labels = [
      ...new Set([...graph.states.keys()].map((id) => labelOf(id))),
    ];
    labels.sort();
    const idOf = (label: string) => `s${labels.indexOf(label)}`;
    const arrowLines = [...arrows.entries()].map(([key, actions]) => {
      const [from = "", to = ""] = key.split("\u0000");
      const names = [...actions];
      names.sort();
      return `  ${idOf(from)} --> ${idOf(to)}: ${names.join(", ")}`;
    });
    arrowLines.sort();
    const lines = [
      "---",
      `title: ${chart.title}`,
      "---",
      "stateDiagram-v2",
      ...labels.map((label) => `  state "${label}" as ${idOf(label)}`),
      `  [*] --> ${idOf(labelOf(graph.initial ?? ""))}`,
      ...arrowLines,
    ];
    return `${lines.join("\n")}\n`;
  } finally {
    rmSync(folder, { force: true, recursive: true });
  }
};

if (import.meta.main && process.argv.includes("--write")) {
  for (const chart of charts) {
    writeFileSync(path.join(modelsDirectory, chart.file), drawChart(chart));
  }
}
