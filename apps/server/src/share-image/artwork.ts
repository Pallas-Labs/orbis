import { decode } from "jpeg-js";

import type { Bitmap } from "./raster.js";

const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 3000;

const readCapped = async (response: Response): Promise<Uint8Array | null> => {
  if (!response.body) {
    return null;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  // `for await` reads one chunk at a time and cancels the stream when the loop
  // exits early, so the bound needs no suppressed read and no explicit cancel.
  for await (const value of response.body) {
    total += value.length;
    if (total > MAX_BYTES) {
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
};

const isJpeg = (bytes: Uint8Array) =>
  bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

const load = async (
  url: string,
  signal: AbortSignal
): Promise<Bitmap | null> => {
  const parsed = URL.parse(url);
  if (parsed?.protocol !== "https:" && parsed?.protocol !== "http:") {
    return null;
  }
  const response = await fetch(parsed, { signal });
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const bytes = await readCapped(response);
  if (!bytes || !isJpeg(bytes)) {
    return null;
  }
  const image = decode(bytes, {
    formatAsRGBA: false,
    maxMemoryUsageInMB: 64,
    maxResolutionInMP: 4,
    useTArray: true,
  });
  return { data: image.data, height: image.height, width: image.width };
};

/**
 * The first of `urls` that loads as a JPEG within the shared time limit, or null. Every
 * failure, from a refused address to a corrupt file, means the image draws without Artwork.
 */
export const loadArtwork = (
  urls: readonly (string | null)[]
): Promise<Bitmap | null> => {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const candidates = [...new Set(urls)];
  // Each address is tried only after the one before fails, so the fallback is
  // stated as a step that names the next one rather than as a suppressed loop.
  const attempt = async (index: number): Promise<Bitmap | null> => {
    const url = candidates[index];
    if (url === undefined) {
      return null;
    }
    if (url !== null) {
      try {
        const image = await load(url, signal);
        if (image) {
          return image;
        }
      } catch {
        // The next address, or no Artwork.
      }
    }
    return await attempt(index + 1);
  };
  return attempt(0);
};
