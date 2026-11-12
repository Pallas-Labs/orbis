import { expect, test } from "bun:test";

import { DEV_AUDIO_NODE_URL, devSecrets, usesLocalState } from "./dev.ts";

// Written before dev.ts. Each is a way `alchemy dev` failed an agent that has no Cloudflare login:
// - it read the shared state store on Cloudflare, which needs Parth's profile
// - it had no stream secret, so every API request answered 500
// and a way the fix could harm a deploy:
// - a deploy takes a made-up secret or keeps its state in one checkout

test.each(["true", "1", "yes", "on"])(
  "ALCHEMY_DEV=%s keeps state in the checkout",
  (value) => {
    expect(usesLocalState({ ALCHEMY_DEV: value })).toBe(true);
  }
);

test.each([undefined, "", "false", "0"])(
  "ALCHEMY_DEV=%s keeps state on Cloudflare",
  (value) => {
    expect(usesLocalState({ ALCHEMY_DEV: value })).toBe(false);
  }
);

test("dev fills only what the API cannot start without", () => {
  const secrets = devSecrets({ dev: true, random: () => "ab".repeat(32) });
  expect(secrets).toEqual({ STREAM_GRANT_SECRET: "ab".repeat(32) });
});

test("a deploy gets no made-up secret", () => {
  expect(devSecrets({ dev: false, random: () => "ab".repeat(32) })).toEqual({});
});

test("the dev audio node is a loopback address", () => {
  expect(new URL(DEV_AUDIO_NODE_URL).hostname).toBe("127.0.0.1");
});
