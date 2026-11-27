#!/usr/bin/env bun
// `orbis-mcp`: Orbis Code Mode as an MCP server on stdio (PAL-3053). It reads `ORBIS_URL` and
// `ORBIS_DEVICE_TOKEN` from the environment. Stdout carries the protocol, so every log and the
// last error go to stderr.
import { BunRuntime } from "@effect/platform-bun";
import { Cause, Console, Effect, Layer, References } from "effect";
import { FetchHttpClient } from "effect/http";

import { OrbisClient } from "./client.js";
import { stdioServer } from "./mcp.js";

const server = stdioServer.pipe(
  Layer.provide(OrbisClient.fromEnv),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Layer.succeed(References.LogToStderr, true))
);

BunRuntime.runMain(
  Layer.launch(server).pipe(
    Effect.tapCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Console.error(Cause.pretty(cause))
    )
  ),
  { disableErrorReporting: true }
);
