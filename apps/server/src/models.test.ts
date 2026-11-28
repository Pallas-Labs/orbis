import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  charts,
  checks,
  drawChart,
  modelsDirectory,
  runCheck,
} from "./models.js";

// Ways this check could pass while the models are wrong:
// - everystate is missing or does not start, and a failed run reads as a pass;
// - a spec or `.cfg` no longer parses (exit 150 or 151) and counts as the negative check;
// - the broken configuration fails on a rule other than the one its mutation breaks;
// - a known gap closes or moves to another rule, and nobody updates the model;
// - a committed chart no longer matches the model it was drawn from.

test.each(checks.map((check) => [check.config, check] as const))(
  "%s keeps its verdict",
  (_config, check) => {
    const result = runCheck(check);
    expect({ exitCode: result.exitCode, verdict: result.verdict }).toEqual({
      exitCode: result.expectedExitCode,
      verdict: check.expect,
    });
    expect(result.distinct).toBeGreaterThan(0);
  }
);

test.each(charts.map((chart) => [chart.file, chart] as const))(
  "%s matches its model",
  (file, chart) => {
    expect(drawChart(chart)).toBe(
      readFileSync(path.join(modelsDirectory, file), "utf-8")
    );
  }
);
