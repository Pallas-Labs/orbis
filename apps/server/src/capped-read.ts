/**
 * Reads a body into memory, or null once it passes `limit` bytes. `for await`
 * cancels the stream when the loop exits early, so a larger body is not read
 * to its end.
 */
export const readCapped = async (
  body: ReadableStream<Uint8Array>,
  limit: number
): Promise<Uint8Array<ArrayBuffer> | null> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > limit) {
      return null;
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
};
