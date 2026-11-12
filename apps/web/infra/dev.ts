/**
 * `alchemy dev` sets `ALCHEMY_DEV=true` on the process that runs the stack. A dev run keeps its
 * state in this checkout's `.alchemy/` directory, so it needs no Cloudflare login and two worktrees
 * never share a state. A deploy keeps its state on Cloudflare.
 */
export const usesLocalState = (
  env: Readonly<Record<string, string | undefined>>
): boolean => ["true", "1", "yes", "on"].includes(env.ALCHEMY_DEV ?? "");

/** Stands in for the audio node in dev, where nothing has to listen: only audio requests fail. */
export const DEV_AUDIO_NODE_URL = "http://127.0.0.1:4310";

/**
 * Values for the secrets the API Worker cannot start without, for a dev run that sets none. Each
 * run makes its own, so they open nothing outside that run. A deploy gets none: an unset secret
 * there keeps the value already on Cloudflare.
 */
export const devSecrets = ({
  dev,
  random,
}: {
  readonly dev: boolean;
  /** 32 random bytes as hex. */
  readonly random: () => string;
}): Readonly<Record<string, string>> =>
  dev ? { STREAM_GRANT_SECRET: random() } : {};
