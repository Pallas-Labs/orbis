// Runs the browser journeys side by side against the built client. Each journey has its own ports,
// data directory, and artifacts directory, so none waits for another. All twelve at once overload
// the host and time out, so at most four run together, longest first. Each one's output
// prints when it ends, so the logs never interleave.
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

const journeys = [
  "presence",
  "playlists",
  "shared-audio",
  "admin-journey",
  "live-queue",
  "journey",
  "tracklist",
  "sign-in",
  "devices",
  "apple-music",
  "pair",
  "share",
  "join",
];
const concurrency = 4;

/// Runs one journey and returns its name when it fails.
const run = async (name) => {
  const started = performance.now();
  const child = spawn(
    process.execPath,
    [path.join(import.meta.dirname, `${name}.mjs`)],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));
  const [code] = await once(child, "close");
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  process.stdout.write(Buffer.concat(output));
  console.log(
    `[e2e] ${name}: ${code === 0 ? "passed" : `exited ${code}`} in ${seconds} s`
  );
  return code === 0 ? [] : [name];
};

/// Takes journeys off the shared queue until it is empty. Recursive rather than a loop, so each
/// journey is a separate await.
const queue = [...journeys];
const lane = async () => {
  const name = queue.shift();
  return name ? [...(await run(name)), ...(await lane())] : [];
};

const lanes = await Promise.all(Array.from({ length: concurrency }, lane));
const failed = lanes.flat();
if (failed.length > 0) {
  console.error(`[e2e] failed: ${failed.join(", ")}`);
  process.exit(1);
}
