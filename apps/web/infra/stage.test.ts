import { expect, test } from "bun:test";

import { stagePlan } from "./stage.ts";

// Written before stage.ts. Each is a way a second stage could harm production:
// - a preview or a personal stage claims orbis.p11a.xyz and takes it from production
// - it claims the /api/* zone route, so production API requests reach its empty Group
// - its page calls the production API with production data

test("prod owns the hostname, the API route and the fixed API address", () => {
  expect(stagePlan("prod")).toEqual({
    apiUrl: "https://orbis.p11a.xyz/api",
    routes: [{ pattern: "orbis.p11a.xyz/api/*", zoneName: "p11a.xyz" }],
    web: { domain: "orbis.p11a.xyz" },
  });
});

test.each(["pr-12", "live_parth", "dev_parth_orbis", "production", "Prod"])(
  "stage %s claims no hostname, route or production API",
  (stage) => {
    expect(stagePlan(stage)).toEqual({
      apiUrl: undefined,
      routes: [],
      web: {},
    });
  }
);
