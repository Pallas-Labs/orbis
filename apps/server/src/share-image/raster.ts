import type { Contour } from "./glyphs.js";

/** An 8-bit RGB image, rows top to bottom. */
export interface Bitmap {
  readonly data: Uint8Array | Uint8ClampedArray;
  readonly height: number;
  readonly width: number;
}

export type Rgb = readonly [number, number, number];

/** Per-pixel coverage from 0 to 1 over a rectangle of the canvas. */
interface Mask {
  readonly coverage: Float32Array;
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export const createCanvas = (width: number, height: number): Bitmap => ({
  data: new Uint8ClampedArray(width * height * 3),
  height,
  width,
});

/** Vertical samples per pixel; horizontal coverage is exact. */
const SUBSAMPLES = 5;

/** Each non-horizontal segment as top y, bottom y, x at top, dx/dy, and winding. */
const edgeTable = (contours: readonly Contour[]) => {
  const edges: number[] = [];
  const bounds = {
    bottom: -Infinity,
    left: Infinity,
    right: -Infinity,
    top: Infinity,
  };
  for (const contour of contours) {
    const count = contour.length / 2;
    for (let index = 0; index < count; index += 1) {
      const x0 = contour[index * 2] ?? 0;
      const y0 = contour[index * 2 + 1] ?? 0;
      const next = (index + 1) % count;
      const x1 = contour[next * 2] ?? 0;
      const y1 = contour[next * 2 + 1] ?? 0;
      bounds.left = Math.min(bounds.left, x0);
      bounds.right = Math.max(bounds.right, x0);
      bounds.top = Math.min(bounds.top, y0);
      bounds.bottom = Math.max(bounds.bottom, y0);
      if (y0 < y1) {
        edges.push(y0, y1, x0, (x1 - x0) / (y1 - y0), 1);
      } else if (y1 < y0) {
        edges.push(y1, y0, x1, (x1 - x0) / (y1 - y0), -1);
      }
    }
  }
  return { bounds, edges };
};

/** Adds one subsample's share of the span from `from` to `to` (canvas x) to a mask row. */
const addSpan = (mask: Mask, row: number, from: number, to: number) => {
  const { coverage } = mask;
  const share = 1 / SUBSAMPLES;
  const start = Math.max(from - mask.x, 0);
  const end = Math.min(to - mask.x, mask.width);
  if (end <= start) {
    return;
  }
  const first = Math.floor(start);
  const last = Math.floor(end);
  const base = row * mask.width;
  if (first === last) {
    coverage[base + first] =
      (coverage[base + first] ?? 0) + (end - start) * share;
    return;
  }
  coverage[base + first] =
    (coverage[base + first] ?? 0) + (first + 1 - start) * share;
  for (let column = first + 1; column < last; column += 1) {
    coverage[base + column] = (coverage[base + column] ?? 0) + share;
  }
  if (last < mask.width) {
    coverage[base + last] = (coverage[base + last] ?? 0) + (end - last) * share;
  }
};

/**
 * Scanline coverage of closed polygons under the nonzero winding rule, clipped to a
 * `width` by `height` canvas. Null when nothing lands on the canvas.
 */
export const rasterize = (
  contours: readonly Contour[],
  width: number,
  height: number
): Mask | null => {
  const { bounds, edges } = edgeTable(contours);
  const x = Math.max(0, Math.floor(bounds.left));
  const y = Math.max(0, Math.floor(bounds.top));
  const maskWidth = Math.min(width, Math.ceil(bounds.right) + 1) - x;
  const maskHeight = Math.min(height, Math.ceil(bounds.bottom) + 1) - y;
  if (maskWidth <= 0 || maskHeight <= 0) {
    return null;
  }
  const mask: Mask = {
    coverage: new Float32Array(maskWidth * maskHeight),
    height: maskHeight,
    width: maskWidth,
    x,
    y,
  };
  const crossings: { at: number; winding: number }[] = [];
  for (let row = 0; row < maskHeight; row += 1) {
    for (let sample = 0; sample < SUBSAMPLES; sample += 1) {
      const scan = y + row + (sample + 0.5) / SUBSAMPLES;
      crossings.length = 0;
      for (let edge = 0; edge < edges.length; edge += 5) {
        const top = edges[edge] ?? 0;
        if (scan >= top && scan < (edges[edge + 1] ?? 0)) {
          crossings.push({
            at: (edges[edge + 2] ?? 0) + (scan - top) * (edges[edge + 3] ?? 0),
            winding: edges[edge + 4] ?? 0,
          });
        }
      }
      crossings.sort((a, b) => a.at - b.at);
      let winding = 0;
      let start = 0;
      for (const crossing of crossings) {
        const before = winding;
        winding += crossing.winding;
        if (before === 0) {
          start = crossing.at;
        } else if (winding === 0) {
          addSpan(mask, row, start, crossing.at);
        }
      }
    }
  }
  return mask;
};

/** Mixes `red`, `green`, `blue` into canvas pixel `pixel` by `alpha`. */
const mix = (
  data: Bitmap["data"],
  pixel: number,
  alpha: number,
  red: number,
  green: number,
  blue: number
) => {
  data[pixel] = (data[pixel] ?? 0) + (red - (data[pixel] ?? 0)) * alpha;
  data[pixel + 1] =
    (data[pixel + 1] ?? 0) + (green - (data[pixel + 1] ?? 0)) * alpha;
  data[pixel + 2] =
    (data[pixel + 2] ?? 0) + (blue - (data[pixel + 2] ?? 0)) * alpha;
};

const blendColor = (
  canvas: Bitmap,
  mask: Mask,
  color: Rgb,
  opacity: number
) => {
  const [red, green, blue] = color;
  for (let row = 0; row < mask.height; row += 1) {
    const canvasRow = (mask.y + row) * canvas.width + mask.x;
    for (let column = 0; column < mask.width; column += 1) {
      const alpha =
        Math.min(1, mask.coverage[row * mask.width + column] ?? 0) * opacity;
      if (alpha > 0) {
        mix(canvas.data, (canvasRow + column) * 3, alpha, red, green, blue);
      }
    }
  }
};

export const fill = (
  canvas: Bitmap,
  contours: readonly Contour[],
  color: Rgb,
  opacity = 1
) => {
  const mask = rasterize(contours, canvas.width, canvas.height);
  if (mask) {
    blendColor(canvas, mask, color, opacity);
  }
};

/** Draws `image` with its top-left corner at `left`, `top`, clipped by the polygons. */
export const fillWithImage = (
  canvas: Bitmap,
  contours: readonly Contour[],
  image: Bitmap,
  left: number,
  top: number
) => {
  const mask = rasterize(contours, canvas.width, canvas.height);
  if (!mask) {
    return;
  }
  for (let row = 0; row < mask.height; row += 1) {
    const canvasRow = (mask.y + row) * canvas.width + mask.x;
    const imageRow =
      Math.min(image.height - 1, Math.max(0, mask.y + row - top)) * image.width;
    for (let column = 0; column < mask.width; column += 1) {
      const alpha = Math.min(1, mask.coverage[row * mask.width + column] ?? 0);
      if (alpha > 0) {
        const source =
          (imageRow +
            Math.min(image.width - 1, Math.max(0, mask.x + column - left))) *
          3;
        mix(
          canvas.data,
          (canvasRow + column) * 3,
          alpha,
          image.data[source] ?? 0,
          image.data[source + 1] ?? 0,
          image.data[source + 2] ?? 0
        );
      }
    }
  }
};

/**
 * A soft shadow under a rounded rectangle, from its signed distance: opaque inside, fading
 * to nothing over `blur` pixels either side of the edge.
 */
export const shadow = (
  canvas: Bitmap,
  box: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly radius: number;
  },
  blur: number,
  color: Rgb,
  opacity: number
) => {
  const x = Math.max(0, Math.floor(box.x - blur));
  const y = Math.max(0, Math.floor(box.y - blur));
  const width = Math.min(canvas.width, Math.ceil(box.x + box.width + blur)) - x;
  const height =
    Math.min(canvas.height, Math.ceil(box.y + box.height + blur)) - y;
  if (width <= 0 || height <= 0) {
    return;
  }
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const coverage = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const reachY =
      Math.abs(y + row + 0.5 - centerY) - (box.height / 2 - box.radius);
    for (let column = 0; column < width; column += 1) {
      const reachX =
        Math.abs(x + column + 0.5 - centerX) - (box.width / 2 - box.radius);
      const distance =
        Math.hypot(Math.max(reachX, 0), Math.max(reachY, 0)) +
        Math.min(Math.max(reachX, reachY), 0) -
        box.radius;
      const t = Math.min(1, Math.max(0, 0.5 - distance / (2 * blur)));
      coverage[row * width + column] = t * t * (3 - 2 * t);
    }
  }
  blendColor(canvas, { coverage, height, width, x, y }, color, opacity);
};

/** Three box passes per axis, close to a Gaussian with this radius. Edges repeat. */
export const boxBlur = (
  values: Float32Array | Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  channels: number,
  radius: number
) => {
  const pass = Math.max(1, Math.round(radius / Math.sqrt(3)));
  const line = new Float32Array(Math.max(width, height));
  const run = (count: number, stride: number, start: number) => {
    for (let channel = 0; channel < channels; channel += 1) {
      for (let index = 0; index < count; index += 1) {
        line[index] = values[start + index * stride + channel] ?? 0;
      }
      let sum = 0;
      for (let index = -pass; index <= pass; index += 1) {
        sum += line[Math.min(count - 1, Math.max(0, index))] ?? 0;
      }
      for (let index = 0; index < count; index += 1) {
        values[start + index * stride + channel] = sum / (pass * 2 + 1);
        sum +=
          (line[Math.min(count - 1, index + pass + 1)] ?? 0) -
          (line[Math.max(0, index - pass)] ?? 0);
      }
    }
  };
  for (let repeat = 0; repeat < 3; repeat += 1) {
    for (let row = 0; row < height; row += 1) {
      run(width, channels, row * width * channels);
    }
    for (let column = 0; column < width; column += 1) {
      run(height, width * channels, column * channels);
    }
  }
};

/**
 * Source pixels and weights for each output pixel along one axis, as flat arrays: output
 * `index` reads `counts[index]` taps starting at `index * taps`.
 */
const weights = (
  start: number,
  length: number,
  size: number,
  limit: number
) => {
  const scale = length / size;
  const taps = scale >= 1 ? Math.ceil(scale) + 1 : 2;
  const sources = new Int32Array(size * taps);
  const amounts = new Float32Array(size * taps);
  const counts = new Uint8Array(size);
  const low = Math.max(0, Math.floor(start));
  const high = Math.min(limit, Math.ceil(start + length)) - 1;
  for (let index = 0; index < size; index += 1) {
    let count = 0;
    const put = (source: number, amount: number) => {
      sources[index * taps + count] = Math.min(high, Math.max(low, source));
      amounts[index * taps + count] = amount;
      count += 1;
    };
    if (scale >= 1) {
      const from = start + index * scale;
      const to = from + scale;
      for (let source = Math.floor(from); source < to; source += 1) {
        const overlap = Math.min(to, source + 1) - Math.max(from, source);
        if (overlap > 0) {
          put(source, overlap / scale);
        }
      }
    } else {
      const center = start + (index + 0.5) * scale - 0.5;
      const floor = Math.floor(center);
      put(floor, 1 - (center - floor));
      put(floor + 1, center - floor);
    }
    counts[index] = count;
  }
  return { amounts, counts, sources, taps };
};

/**
 * Scales the `crop` of `image` to `width` by `height`: an area average when shrinking,
 * bilinear when enlarging.
 */
export const resample = (
  image: Bitmap,
  crop: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  width: number,
  height: number
): Bitmap => {
  const across = weights(crop.x, crop.width, width, image.width);
  const down = weights(crop.y, crop.height, height, image.height);
  const firstRow = Math.max(0, Math.floor(crop.y));
  const lastRow = Math.min(image.height, Math.ceil(crop.y + crop.height) + 1);
  const source = image.data;
  const rows = new Float32Array((lastRow - firstRow) * width * 3);
  for (let row = firstRow; row < lastRow; row += 1) {
    const rowStart = row * image.width;
    for (let column = 0; column < width; column += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      const count = across.counts[column] ?? 0;
      for (let tap = 0; tap < count; tap += 1) {
        const slot = column * across.taps + tap;
        const pixel = (rowStart + (across.sources[slot] ?? 0)) * 3;
        const amount = across.amounts[slot] ?? 0;
        red += (source[pixel] ?? 0) * amount;
        green += (source[pixel + 1] ?? 0) * amount;
        blue += (source[pixel + 2] ?? 0) * amount;
      }
      const target = ((row - firstRow) * width + column) * 3;
      rows[target] = red;
      rows[target + 1] = green;
      rows[target + 2] = blue;
    }
  }
  const output = createCanvas(width, height);
  for (let row = 0; row < height; row += 1) {
    const count = down.counts[row] ?? 0;
    for (let column = 0; column < width; column += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let tap = 0; tap < count; tap += 1) {
        const slot = row * down.taps + tap;
        const pixel =
          (((down.sources[slot] ?? 0) - firstRow) * width + column) * 3;
        const amount = down.amounts[slot] ?? 0;
        red += (rows[pixel] ?? 0) * amount;
        green += (rows[pixel + 1] ?? 0) * amount;
        blue += (rows[pixel + 2] ?? 0) * amount;
      }
      const target = (row * width + column) * 3;
      output.data[target] = red;
      output.data[target + 1] = green;
      output.data[target + 2] = blue;
    }
  }
  return output;
};

/** A rectangle with circular corners as one polygon. */
export const roundedRectangle = (
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): Contour => {
  const points: number[] = [];
  const corners: readonly [number, number, number][] = [
    [x + width - radius, y + radius, -Math.PI / 2],
    [x + width - radius, y + height - radius, 0],
    [x + radius, y + height - radius, Math.PI / 2],
    [x + radius, y + radius, Math.PI],
  ];
  for (const [centerX, centerY, from] of corners) {
    for (let step = 0; step <= 12; step += 1) {
      const angle = from + (step / 12) * (Math.PI / 2);
      points.push(
        centerX + Math.cos(angle) * radius,
        centerY + Math.sin(angle) * radius
      );
    }
  }
  return points;
};

export const circle = (x: number, y: number, radius: number): Contour =>
  Array.from({ length: 48 }, (_, step) => {
    const angle = (step / 48) * Math.PI * 2;
    return [x + Math.cos(angle) * radius, y + Math.sin(angle) * radius];
  }).flat();
