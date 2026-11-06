/**
 * Writes `inter.ts`, the glyph outlines the share image draws, from Inter 4.1.
 *
 * Run from the repository root with `bun apps/server/src/share-image/generate-inter.ts`.
 * It downloads the pinned release, checks its SHA-256, and packs each font's outlines for
 * the code points below into one base64 string. The runtime then needs no font parser.
 * Requires `unzip`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parse } from "opentype.js";
import type { Font } from "opentype.js";

import { COMMAND } from "./glyphs.js";

const RELEASE =
  "https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip";
const RELEASE_SHA256 =
  "9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e";
const FONTS = {
  INTER_DISPLAY_BOLD: "extras/ttf/InterDisplay-Bold.ttf",
  INTER_MEDIUM: "extras/ttf/Inter-Medium.ttf",
} as const;
const ranges: readonly (readonly [number, number])[] = [
  [0x20, 0x7e],
  [0xa0, 0x1_7f],
  [0x4_00, 0x4_5f],
  [0x20_10, 0x20_27],
  [0x20_30, 0x20_3a],
  [0x20_ac, 0x20_ac],
  [0x21_22, 0x21_22],
];
const codePoints = ranges.flatMap(([first, last]) =>
  Array.from({ length: last - first + 1 }, (_, index) => first + index)
);
/** Kerning matters most between Latin letters and punctuation; other pairs cost bytes. */
const kerned = codePoints.filter((point) => point <= 0x7e);

const pack = (font: Font): string => {
  const present = codePoints.filter(
    (point) => font.charToGlyphIndex(String.fromCodePoint(point)) > 0
  );
  const outlines = present.map((point) => {
    const glyph = font.charToGlyph(String.fromCodePoint(point));
    const bytes: number[] = [];
    const pair = new DataView(new ArrayBuffer(2));
    const coordinate = (value: number) => {
      pair.setInt16(0, Math.round(value), true);
      bytes.push(pair.getUint8(0), pair.getUint8(1));
    };
    let commands = 0;
    for (const command of glyph.path.commands) {
      commands += 1;
      if (command.type === "M" || command.type === "L") {
        bytes.push(command.type === "M" ? COMMAND.move : COMMAND.line);
        coordinate(command.x);
        coordinate(command.y);
      } else if (command.type === "Q") {
        bytes.push(COMMAND.quadratic);
        coordinate(command.x1);
        coordinate(command.y1);
        coordinate(command.x);
        coordinate(command.y);
      } else if (command.type === "Z") {
        bytes.push(COMMAND.close);
      } else {
        throw new Error(`Inter has a cubic curve in U+${point.toString(16)}.`);
      }
    }
    return { advance: glyph.advanceWidth ?? 0, bytes, commands, point };
  });
  const pairs = kerned.flatMap((left) =>
    kerned.flatMap((right) => {
      const value = font.getKerningValue(
        font.charToGlyph(String.fromCodePoint(left)),
        font.charToGlyph(String.fromCodePoint(right))
      );
      return value === 0 ? [] : [{ left, right, value }];
    })
  );
  const header = 10;
  const glyphRecord = 12;
  const pairRecord = 6;
  const outlineStart =
    header + outlines.length * glyphRecord + pairs.length * pairRecord;
  const size =
    outlineStart +
    outlines.reduce((total, outline) => total + outline.bytes.length, 0);
  const view = new DataView(new ArrayBuffer(size));
  view.setUint16(0, font.unitsPerEm, true);
  view.setInt16(2, font.ascender, true);
  view.setInt16(4, font.descender, true);
  view.setUint16(6, outlines.length, true);
  view.setUint16(8, pairs.length, true);
  let offset = outlineStart;
  for (const [index, outline] of outlines.entries()) {
    const record = header + index * glyphRecord;
    view.setUint32(record, outline.point, true);
    view.setUint16(record + 4, outline.advance, true);
    view.setUint16(record + 6, outline.commands, true);
    view.setUint32(record + 8, offset, true);
    for (const byte of outline.bytes) {
      view.setUint8(offset, byte);
      offset += 1;
    }
  }
  for (const [index, pair] of pairs.entries()) {
    const record = header + outlines.length * glyphRecord + index * pairRecord;
    view.setUint16(record, pair.left, true);
    view.setUint16(record + 2, pair.right, true);
    view.setInt16(record + 4, pair.value, true);
  }
  return Buffer.from(view.buffer).toString("base64");
};

const directory = mkdtempSync(path.join(tmpdir(), "orbis-inter-"));
try {
  const archive = path.join(directory, "Inter.zip");
  const response = await fetch(RELEASE, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Inter download failed with ${response.status}.`);
  }
  const zip = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(zip).digest("hex");
  if (digest !== RELEASE_SHA256) {
    throw new Error(`Inter release digest changed: ${digest}.`);
  }
  writeFileSync(archive, zip);
  const read = (member: string) =>
    execFileSync("unzip", ["-p", archive, member], {
      maxBuffer: 16 * 1024 * 1024,
    });
  const exports = Object.entries(FONTS).map(([name, member]) => {
    const file = read(member);
    const font = parse(
      file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)
    );
    return `export const ${name} =\n  "${pack(font)}";\n`;
  });
  const license = read("LICENSE.txt").toString("utf-8");
  writeFileSync(path.join(import.meta.dir, "Inter-LICENSE.txt"), license);
  writeFileSync(
    path.join(import.meta.dir, "inter.ts"),
    [
      `// Generated by generate-inter.ts from ${RELEASE}`,
      `// (SHA-256 ${RELEASE_SHA256}). Inter is under the SIL Open Font License 1.1;`,
      "// see Inter-LICENSE.txt. Do not edit.",
      "",
      ...exports,
    ].join("\n")
  );
} finally {
  rmSync(directory, { force: true, recursive: true });
}
