/** Outline operations as `generate-inter.ts` packs them, each followed by int16 pairs. */
export const COMMAND = { close: 3, line: 1, move: 0, quadratic: 2 } as const;

interface Glyph {
  readonly advance: number;
  readonly commands: number;
  readonly offset: number;
}

export interface Font {
  readonly ascender: number;
  readonly glyphs: ReadonlyMap<number, Glyph>;
  /** Keyed by `left * 0x10000 + right`. */
  readonly kerning: ReadonlyMap<number, number>;
  readonly unitsPerEm: number;
  readonly view: DataView;
}

/** A closed polygon as x, y pairs in canvas pixels. */
export type Contour = readonly number[];

export const loadFont = (base64: string): Font => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.codePointAt(index) ?? 0;
  }
  const view = new DataView(bytes.buffer);
  const glyphCount = view.getUint16(6, true);
  const pairCount = view.getUint16(8, true);
  const glyphs = new Map<number, Glyph>();
  for (let index = 0; index < glyphCount; index += 1) {
    const record = 10 + index * 12;
    glyphs.set(view.getUint32(record, true), {
      advance: view.getUint16(record + 4, true),
      commands: view.getUint16(record + 6, true),
      offset: view.getUint32(record + 8, true),
    });
  }
  const kerning = new Map<number, number>();
  for (let index = 0; index < pairCount; index += 1) {
    const record = 10 + glyphCount * 12 + index * 6;
    kerning.set(
      view.getUint16(record, true) * 0x1_00_00 +
        view.getUint16(record + 2, true),
      view.getInt16(record + 4, true)
    );
  }
  return {
    ascender: view.getInt16(2, true),
    glyphs,
    kerning,
    unitsPerEm: view.getUint16(0, true),
    view,
  };
};

const codePoints = (text: string): number[] =>
  Array.from(
    text.normalize("NFC"),
    (character) => character.codePointAt(0) ?? 0
  );

/** Each drawable code point and its pen position in pixels; a code point the font lacks is skipped. */
const place = (font: Font, size: number, text: string) => {
  const scale = size / font.unitsPerEm;
  const placed: { readonly glyph: Glyph; readonly x: number }[] = [];
  let pen = 0;
  let previous: number | null = null;
  for (const point of codePoints(text)) {
    const glyph = font.glyphs.get(point);
    if (glyph) {
      if (previous !== null) {
        pen += (font.kerning.get(previous * 0x1_00_00 + point) ?? 0) * scale;
      }
      placed.push({ glyph, x: pen });
      pen += glyph.advance * scale;
      previous = point;
    }
  }
  return { placed, width: pen };
};

export const measure = (font: Font, size: number, text: string): number =>
  place(font, size, text).width;

/** How far a quadratic may stray from its chords, in pixels. */
const TOLERANCE = 0.2;

/** Outlines for `text` with its baseline at `y`, flattened to polygons. */
export const textContours = (
  font: Font,
  size: number,
  text: string,
  x: number,
  y: number
): Contour[][] => {
  const scale = size / font.unitsPerEm;
  const { view } = font;
  return place(font, size, text).placed.map(({ glyph, x: pen }) => {
    const contours: Contour[] = [];
    let current: number[] = [];
    let { offset } = glyph;
    const read = () => {
      const value = view.getInt16(offset, true);
      offset += 2;
      return value;
    };
    const left = x + pen;
    for (let index = 0; index < glyph.commands; index += 1) {
      const operation = view.getUint8(offset);
      offset += 1;
      if (operation === COMMAND.close) {
        if (current.length >= 6) {
          contours.push(current);
        }
        current = [];
      } else if (operation === COMMAND.quadratic) {
        const controlX = left + read() * scale;
        const controlY = y - read() * scale;
        const endX = left + read() * scale;
        const endY = y - read() * scale;
        const startX = current.at(-2) ?? endX;
        const startY = current.at(-1) ?? endY;
        const deviation =
          Math.hypot(
            startX - 2 * controlX + endX,
            startY - 2 * controlY + endY
          ) / 4;
        const steps = Math.min(
          16,
          Math.max(1, Math.ceil(Math.sqrt(deviation / TOLERANCE)))
        );
        for (let step = 1; step <= steps; step += 1) {
          const t = step / steps;
          const u = 1 - t;
          current.push(
            u * u * startX + 2 * u * t * controlX + t * t * endX,
            u * u * startY + 2 * u * t * controlY + t * t * endY
          );
        }
      } else {
        if (operation === COMMAND.move && current.length >= 6) {
          contours.push(current);
          current = [];
        }
        current.push(left + read() * scale, y - read() * scale);
      }
    }
    if (current.length >= 6) {
      contours.push(current);
    }
    return contours;
  });
};

const ELLIPSIS = "…";

interface Wrapped {
  readonly lines: string[];
  readonly truncated: boolean;
}

/**
 * Greedy word wrap into at most `maxLines` lines no wider than `width`. A word wider than a
 * line breaks between characters, and text past the last line ends in an ellipsis.
 */
export const wrap = (
  font: Font,
  size: number,
  text: string,
  width: number,
  maxLines: number
): Wrapped => {
  const fits = (candidate: string) => measure(font, size, candidate) <= width;
  const lines: string[] = [];
  let line = "";
  const words = text.trim().split(/\s+/u).filter(Boolean);
  for (const word of words) {
    const joined = line === "" ? word : `${line} ${word}`;
    if (fits(joined)) {
      line = joined;
    } else {
      if (line !== "") {
        lines.push(line);
      }
      line = "";
      for (const character of word) {
        if (line !== "" && !fits(line + character)) {
          lines.push(line);
          line = "";
        }
        line += character;
      }
    }
  }
  if (line !== "") {
    lines.push(line);
  }
  if (lines.length <= maxLines) {
    return { lines, truncated: false };
  }
  const kept = lines.slice(0, maxLines);
  let last = `${kept.at(-1) ?? ""} ${lines[maxLines] ?? ""}`;
  const graphemes = Array.from(
    new Intl.Segmenter().segment(last),
    ({ segment }) => segment
  );
  while (
    graphemes.length > 0 &&
    !fits(`${graphemes.join("").trimEnd()}${ELLIPSIS}`)
  ) {
    graphemes.pop();
  }
  last = graphemes.join("");
  kept[maxLines - 1] = `${last.trimEnd()}${ELLIPSIS}`;
  return { lines: kept, truncated: true };
};
