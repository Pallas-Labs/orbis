import { expect, test } from "bun:test";

import {
  ACCEPTED_SOURCE_URL_CASES,
  REJECTED_SOURCE_URLS,
} from "@orbis/contracts/source-url-cases";

import { SOURCE_URL_MESSAGE } from "@orbis/contracts";

import { LibraryError } from "./errors.js";
import { normalizeSourceUrl } from "./source-url.js";

test("normalizes the canonical Source Link forms without widening the allowlist", () => {
  for (const { input, source, url } of ACCEPTED_SOURCE_URL_CASES) {
    expect(normalizeSourceUrl(input)).toEqual({ source, url });
  }
});

test("reports a rejected form as a 400 LibraryError", () => {
  for (const url of REJECTED_SOURCE_URLS) {
    const normalize = () => normalizeSourceUrl(url);
    expect(normalize).toThrow(LibraryError);
    expect(normalize).toThrow(
      expect.objectContaining({
        message: SOURCE_URL_MESSAGE,
        statusCode: 400,
      })
    );
  }
});
