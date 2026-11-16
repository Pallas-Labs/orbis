// Runs the browser journeys side by side against the built client. Each journey asks the OS for
// free ports (`freePort` in `helpers.mjs`) and has its own data directory and artifacts directory,
// so none waits for another, here or in another checkout on the same host. Each journey runs an
// API server, `vite preview` and Chromium, so too many at once starve each other of CPU, and their
// server starts and page waits time out. One runs for every two CPUs this process may use
// (`availableParallelism` reads the cgroup quota, such as the 4 CPUs every agent on Vanta shares),
// at least one and at most four, longest first (PAL-2472). Each one's output prints when it ends,
// so the logs never interleave.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { availableParallelism } from "node:os";
import path from "node:path";

const journeys = [
  "presence",
  "playlists",
  "shared-audio",
  "admin-journey",
  "live-queue",
  "resume-position",
  "journey",
  "tracklist",
  "sign-in",
  "devices",
  "apple-music",
  "pair",
  "share",
  "join",
  "timeout",
];
const concurrency = Math.min(
  4,
  Math.max(1, Math.floor(availableParallelism() / 2))
);

/// Runs one journey and returns its name when it fails.
const run = async (name) => {
  const started = performance.now();
  const child = spawn(
    process.execPath,
    [path.join(import.meta.dirname, `${name}.mjs`)],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const output = [];
  child.stdout.on("data", (chunk) => {
    output.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output.push(chunk);
  });
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
