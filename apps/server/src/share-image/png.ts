/* oxlint-disable no-bitwise -- CRC-32 and PNG filter bytes are bit arithmetic. */
import type { Bitmap } from "./raster.js";

const CRC_TABLE = Int32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
  }
  return value;
});

const crc32 = (bytes: Uint8Array): number => {
  let crc = -1;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
};

const chunk = (type: string, body: Uint8Array): Uint8Array => {
  const bytes = new Uint8Array(body.length + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, body.length);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(body, 8);
  view.setUint32(body.length + 8, crc32(bytes.subarray(4, body.length + 8)));
  return bytes;
};

/** An 8-bit RGB PNG. Every row uses the Up filter, which suits the smooth glow behind the text. */
export const encodePng = async (image: Bitmap): Promise<Uint8Array> => {
  const stride = image.width * 3;
  const raw = new Uint8Array((stride + 1) * image.height);
  for (let row = 0; row < image.height; row += 1) {
    const target = row * (stride + 1);
    raw[target] = 2;
    for (let index = 0; index < stride; index += 1) {
      const at = row * stride + index;
      const up = row > 0 ? (image.data[at - stride] ?? 0) : 0;
      raw[target + 1 + index] = ((image.data[at] ?? 0) - up) & 0xff;
    }
  }
  const compressed = new Uint8Array(
    await new Response(
      new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))
    ).arrayBuffer()
  );
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, image.width);
  view.setUint32(4, image.height);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk("IHDR", header),
    chunk("IDAT", compressed),
    chunk("IEND", new Uint8Array(0)),
  ];
  const png = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0)
  );
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
};
