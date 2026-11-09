import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { Schema } from "effect";

const decodeTcpAddress = Schema.decodeUnknownSync(
  Schema.Struct({ port: Schema.Int })
);

/** Headers node:http writes from the body it sends, never copied from the handler. */
const framingHeaders = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
]);

/** The request body as a web stream. API bodies are small, so it reads without backpressure. */
const requestBody = (incoming: IncomingMessage): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    cancel: () => {
      incoming.destroy();
    },
    start: (controller) => {
      incoming.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      incoming.once("end", () => {
        controller.close();
      });
      incoming.once("error", (error) => {
        controller.error(error);
      });
    },
  });

const incomingRequest = (
  incoming: IncomingMessage,
  origin: string,
  signal: AbortSignal
): Request => {
  const headers = new Headers();
  for (let index = 0; index + 1 < incoming.rawHeaders.length; index += 2) {
    headers.append(
      incoming.rawHeaders[index] ?? "",
      incoming.rawHeaders[index + 1] ?? ""
    );
  }
  const method = incoming.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(new URL(incoming.url ?? "/", origin), {
    body: hasBody ? requestBody(incoming) : null,
    headers,
    method,
    signal,
  });
};

const writeResponse = async (
  response: Response,
  outgoing: ServerResponse
): Promise<void> => {
  for (const [name, value] of response.headers) {
    if (!framingHeaders.has(name) && name !== "set-cookie") {
      outgoing.setHeader(name, value);
    }
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) {
    outgoing.setHeader("set-cookie", cookies);
  }
  outgoing.writeHead(response.status);
  if (response.body === null) {
    outgoing.end();
    return;
  }
  await pipeline(Readable.from(response.body), outgoing);
};

const respond = async (
  handler: (request: Request) => Promise<Response>,
  origin: string,
  incoming: IncomingMessage,
  outgoing: ServerResponse
): Promise<void> => {
  const departed = new AbortController();
  outgoing.once("close", () => {
    if (!outgoing.writableFinished) {
      departed.abort();
    }
  });
  try {
    const response = await handler(
      incomingRequest(incoming, origin, departed.signal)
    );
    await writeResponse(response, outgoing);
  } catch {
    // A client that left mid-body ends the pipeline early; that is not a failure to report.
    if (outgoing.headersSent) {
      outgoing.destroy();
    } else {
      outgoing.writeHead(500).end();
    }
  }
};

export interface NodeListener {
  readonly url: URL;
  readonly stop: () => Promise<void>;
}

/**
 * Serves a fetch-style handler over node:http. Bun.serve sends any streamed body as chunked
 * and drops the handler's Content-Length (oven-sh/bun#35682); node:http keeps it, so a 206
 * audio body can be metered as it leaves and still tell the player how long it is.
 */
export const listen = async (
  handler: (request: Request) => Promise<Response>,
  options: { readonly hostname: string; readonly port: number }
): Promise<NodeListener> => {
  const origin = `http://${options.hostname}`;
  const server = createServer((incoming, outgoing) => {
    void respond(handler, origin, incoming, outgoing);
  });
  server.listen(options.port, options.hostname);
  await once(server, "listening");
  // An IP listener's address is `{ address, family, port }`; only a pipe answers a string.
  const { port } = decodeTcpAddress(server.address());
  return {
    stop: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
    url: new URL(`http://${options.hostname}:${String(port)}/`),
  };
};
