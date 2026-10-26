import type { SetSource } from "@orbis/contracts";

import type { Font } from "./glyphs.js";
import { loadFont, textContours, wrap } from "./glyphs.js";
import { INTER_DISPLAY_BOLD, INTER_MEDIUM } from "./inter.js";
import { encodePng } from "./png.js";
import type { Bitmap, Rgb } from "./raster.js";
import {
  boxBlur,
  circle,
  createCanvas,
  fill,
  fillWithImage,
  resample,
  roundedRectangle,
  shadow,
} from "./raster.js";

export const WIDTH = 1200;
export const HEIGHT = 630;
const PADDING = 72;
const MARK_SIZE = 34;
/** Where the card and the text block center, below the Orbis mark. */
const CONTENT_MIDDLE = (PADDING + MARK_SIZE + HEIGHT - PADDING) / 2 + 12;

/** Dark appearance tokens from docs/design/tokens.json, in sRGB. */
const PAPER: Rgb = [4, 4, 5];
const INK: Rgb = [238, 234, 247];
const MUTED: Rgb = [214, 202, 238];
const TINT: Rgb = [165, 77, 255];

let fonts: { readonly bold: Font; readonly medium: Font } | null = null;
const loadFonts = () => {
  fonts ??= {
    bold: loadFont(INTER_DISPLAY_BOLD),
    medium: loadFont(INTER_MEDIUM),
  };
  return fonts;
};

export interface ShareCard {
  readonly artwork: Bitmap | null;
  readonly creator: string | null;
  readonly source: SetSource;
  readonly title: string;
}

/** The centered part of an image with the given aspect ratio. */
const coverCrop = (image: Bitmap, aspect: number) =>
  image.width / image.height > aspect
    ? {
        height: image.height,
        width: image.height * aspect,
        x: (image.width - image.height * aspect) / 2,
        y: 0,
      }
    : {
        height: image.width / aspect,
        width: image.width,
        x: 0,
        y: (image.height - image.width / aspect) / 2,
      };

/**
 * The Artwork blown up, blurred, saturated, and darkened, as the app's ArtworkGlow draws
 * it. Blurring a tenth-size copy and enlarging it costs a fraction of blurring at full size.
 */
const glowCanvas = (artwork: Bitmap): Bitmap => {
  const small = resample(
    artwork,
    coverCrop(artwork, WIDTH / HEIGHT),
    WIDTH / 10,
    HEIGHT / 10
  );
  boxBlur(small.data, small.width, small.height, 3, 4);
  const canvas = resample(
    small,
    { height: small.height, width: small.width, x: 0, y: 0 },
    WIDTH,
    HEIGHT
  );
  const { data } = canvas;
  const [paperRed, paperGreen, paperBlue] = PAPER;
  for (let row = 0; row < HEIGHT; row += 1) {
    // Darker toward the bottom, like the app's scrim, so the text reads on bright Artwork.
    const keep = 0.5 - (row / HEIGHT) * 0.18;
    for (
      let pixel = row * WIDTH * 3;
      pixel < (row + 1) * WIDTH * 3;
      pixel += 3
    ) {
      const red = data[pixel] ?? 0;
      const green = data[pixel + 1] ?? 0;
      const blue = data[pixel + 2] ?? 0;
      const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      data[pixel] = paperRed + (luma + (red - luma) * 1.4 - paperRed) * keep;
      data[pixel + 1] =
        paperGreen + (luma + (green - luma) * 1.4 - paperGreen) * keep;
      data[pixel + 2] =
        paperBlue + (luma + (blue - luma) * 1.4 - paperBlue) * keep;
    }
  }
  return canvas;
};

/** Paper with a wash of the tint from the top left, as the app's TintGlow draws it. */
const paintTint = (canvas: Bitmap) => {
  const { data } = canvas;
  const reach = 1000;
  for (let row = 0; row < HEIGHT; row += 1) {
    for (let column = 0; column < WIDTH; column += 1) {
      const distance = Math.hypot(column - 260, row + 160) / reach;
      const strength =
        distance < 0.5
          ? 0.3 - distance * 0.38
          : Math.max(0, 0.11 * (1 - (distance - 0.5) / 0.5));
      const pixel = (row * WIDTH + column) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        data[pixel + channel] =
          (PAPER[channel] ?? 0) +
          ((TINT[channel] ?? 0) - (PAPER[channel] ?? 0)) * strength;
      }
    }
  }
};

const paintText = (
  canvas: Bitmap,
  font: Font,
  size: number,
  text: string,
  x: number,
  baseline: number,
  color: Rgb
) => {
  for (const glyph of textContours(font, size, text, x, baseline)) {
    fill(canvas, glyph, color);
  }
};

const paintCard = (canvas: Bitmap, artwork: Bitmap, source: SetSource) => {
  const aspect = source === "youtube" ? 16 / 9 : 1;
  const width = source === "youtube" ? 512 : 400;
  const height = Math.round(width / aspect);
  const x = PADDING;
  const y = Math.round(CONTENT_MIDDLE - height / 2);
  const radius = 22;
  shadow(canvas, { height, radius, width, x, y: y + 14 }, 28, [0, 0, 0], 0.55);
  const picture = resample(artwork, coverCrop(artwork, aspect), width, height);
  fillWithImage(
    canvas,
    [roundedRectangle(x, y, width, height, radius)],
    picture,
    x,
    y
  );
  const inner = roundedRectangle(
    x + 1,
    y + 1,
    width - 2,
    height - 2,
    radius - 1
  );
  const reversed: number[] = [];
  for (let index = inner.length - 2; index >= 0; index -= 2) {
    reversed.push(inner[index] ?? 0, inner[index + 1] ?? 0);
  }
  fill(
    canvas,
    [roundedRectangle(x, y, width, height, radius), reversed],
    [255, 255, 255],
    0.12
  );
  return width;
};

const paintMark = (canvas: Bitmap, bold: Font) => {
  fill(canvas, [circle(PADDING + 14, PADDING + 13, 14)], TINT);
  paintText(canvas, bold, MARK_SIZE, "Orbis", PADDING + 40, PADDING + 25, INK);
};

/**
 * The 1200x630 preview an Orbis Link unfurls into: the Set's Artwork as a card over its own
 * blurred glow, the provider title, the creator, and the Orbis mark.
 */
export const renderShareImage = (card: ShareCard): Promise<Uint8Array> => {
  const { bold, medium } = loadFonts();
  const canvas = card.artwork
    ? glowCanvas(card.artwork)
    : createCanvas(WIDTH, HEIGHT);
  let textLeft = PADDING;
  if (card.artwork) {
    textLeft = PADDING + paintCard(canvas, card.artwork, card.source) + 56;
  } else {
    paintTint(canvas);
  }
  paintMark(canvas, bold);
  const textWidth = WIDTH - PADDING - textLeft;
  const sizes = card.artwork ? [64, 56, 48] : [84, 72, 60];
  const creatorSize = card.artwork ? 30 : 36;
  const fitted =
    sizes
      .map((size) => ({ size, ...wrap(bold, size, card.title, textWidth, 3) }))
      .find((candidate) => !candidate.truncated) ??
    (() => {
      const size = sizes.at(-1) ?? 48;
      return { size, ...wrap(bold, size, card.title, textWidth, 3) };
    })();
  const lineHeight = Math.round(fitted.size * 1.12);
  const creator = card.creator
    ? (wrap(medium, creatorSize, card.creator, textWidth, 1).lines[0] ?? "")
    : "";
  const creatorBlock = creator ? 20 + creatorSize * 1.2 : 0;
  const blockHeight = fitted.lines.length * lineHeight + creatorBlock;
  let baseline = CONTENT_MIDDLE - blockHeight / 2 + fitted.size * 0.86;
  for (const line of fitted.lines) {
    paintText(canvas, bold, fitted.size, line, textLeft, baseline, INK);
    baseline += lineHeight;
  }
  if (creator) {
    paintText(
      canvas,
      medium,
      creatorSize,
      creator,
      textLeft,
      baseline - lineHeight + 20 + creatorSize * 1.2,
      MUTED
    );
  }
  return encodePng(canvas);
};
