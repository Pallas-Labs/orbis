import { definePlugin } from "@oxlint/plugins";

import noEmDashCopy from "./rules/no-em-dash-copy.ts";
import noInlineSchemaCompile from "./rules/no-inline-schema-compile.ts";
import noTestInLoop from "./rules/no-test-in-loop.ts";
import noTestTimeoutOrUnreasonedSkip from "./rules/no-test-timeout-or-unreasoned-skip.ts";
import noWallClockInTests from "./rules/no-wall-clock-in-tests.ts";
import preferEffectFn from "./rules/prefer-effect-fn.ts";
import requireSuppressionReason from "./rules/require-suppression-reason.ts";

export default definePlugin({
  meta: {
    name: "t3code",
  },
  rules: {
    "no-em-dash-copy": noEmDashCopy,
    "no-inline-schema-compile": noInlineSchemaCompile,
    "no-test-in-loop": noTestInLoop,
    "no-test-timeout-or-unreasoned-skip": noTestTimeoutOrUnreasonedSkip,
    "no-wall-clock-in-tests": noWallClockInTests,
    "prefer-effect-fn": preferEffectFn,
    "require-suppression-reason": requireSuppressionReason,
  },
});
