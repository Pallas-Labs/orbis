// The Orbis Code Mode MCP server (PAL-3053), on stdio, with two tools. `search` finds capabilities
// and their TypeScript declarations; `execute` runs a program against them on the engine.
import { BunStdio } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";

import { plain as json } from "./catalog.js";
import { OrbisClient } from "./client.js";
import { defaultTimeoutMs, execute } from "./engine.js";
import { search } from "./search.js";
import type { SearchQuery } from "./search.js";

const instructions = [
  "The caller's Orbis library for one-call joins and batch curation.",
  "Call `search` to find functions and their TypeScript declarations, then `execute` a JavaScript program that awaits them, such as",
  "`const { sets } = await sets.list({ tag: ['techno'] }); return sets.length`.",
  "Namespaces: sets, playlists, library, queue, people read; curate makes reversible changes to the caller's own Sets, Playlists and Collections.",
].join(" ");

const SearchTool = Tool.make("search", {
  description:
    "Find Orbis Code Mode functions by words in their name or description, optionally in one namespace, a page at a time. Each hit carries its TypeScript declaration.",
  parameters: Schema.Struct({
    limit: Schema.optionalKey(Schema.Int),
    namespace: Schema.optionalKey(Schema.String),
    offset: Schema.optionalKey(Schema.Int),
    query: Schema.optionalKey(Schema.String),
  }),
  success: Schema.Json,
});

const ExecuteTool = Tool.make("execute", {
  description: `Run a JavaScript program (async, top-level await and return) against the Orbis namespaces. Returns { ok, value | error, logs, warnings, toolCalls }. No file system, network, process or timers; times out after timeoutMs (default ${defaultTimeoutMs}, at most 60000).`,
  parameters: Schema.Struct({
    code: Schema.String,
    timeoutMs: Schema.optionalKey(Schema.Int),
  }),
  success: Schema.Json,
});

export const CodemodeTools = Toolkit.make(SearchTool, ExecuteTool);

export const handlers = CodemodeTools.toLayer(
  Effect.gen(function* makeHandlers() {
    const client = yield* OrbisClient;
    return {
      execute: ({
        code,
        timeoutMs,
      }: {
        readonly code: string;
        readonly timeoutMs?: number;
      }) =>
        execute(code, { timeoutMs }).pipe(
          Effect.map(json),
          Effect.provideService(OrbisClient, client)
        ),
      search: (query: SearchQuery) => Effect.succeed(json(search(query))),
    };
  })
);

/** The toolkit with its handlers, as `McpServer.layerStdio` and `McpTest.makeClient` take it. */
export const registrations = McpServer.toolkit(CodemodeTools).pipe(
  Layer.provide(handlers)
);

/** The server on stdin and stdout. Nothing else may write to stdout. */
export const stdioServer = McpServer.layerStdio({
  instructions,
  name: "orbis-codemode",
  protocols: [McpProtocol.v2025_06_18, McpProtocol.v2025_03_26],
  registrations,
  version: "0.1.0",
}).pipe(Layer.provide(BunStdio.layer));
