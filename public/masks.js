// COCO RLE runs alternate background/foreground in column-major order.
// Keep the provider's RLE for export; rasterization never drops holes/components.
export function decodeRLE(rle, maxPixels = 16_777_216) {
  const [height, width] = rle?.size || [];
  if (
    ![height, width].every((n) => Number.isInteger(n) && n > 0) ||
    width * height > maxPixels
  )
    throw new Error("Invalid mask dimensions");
  let counts = rle.counts;
  if (typeof counts === "string") {
    const encoded = counts;
    counts = [];
    for (let position = 0; position < encoded.length; ) {
      let value = 0,
        shift = 0,
        code;
      do {
        if (position >= encoded.length || shift > 30)
          throw new Error("Malformed compressed RLE");
        code = encoded.charCodeAt(position++) - 48;
        if (code < 0 || code > 63) throw new Error("Malformed compressed RLE");
        value += (code & 31) * 2 ** shift;
        shift += 5;
      } while (code & 32);
      if (code & 16) value -= 2 ** shift;
      if (counts.length > 2) value += counts[counts.length - 2];
      counts.push(value);
      if (counts.length > width * height + 1)
        throw new Error("Too many RLE runs");
    }
  }
  if (
    !Array.isArray(counts) ||
    !counts.length ||
    counts.length > width * height + 1 ||
    counts.some((n) => !Number.isSafeInteger(n) || n < 0) ||
    counts.reduce((a, b) => a + b, 0) !== width * height
  )
    throw new Error("RLE runs do not match the mask grid");
  const pixels = new Uint8Array(width * height);
  let offset = 0;
  counts.forEach((count, index) => {
    if (index % 2)
      for (let i = offset; i < offset + count; i++)
        pixels[(i % height) * width + Math.floor(i / height)] = 1;
    offset += count;
  });
  return { pixels, width, height };
}

export function encodeRLE(pixels, width, height) {
  if (pixels.length !== width * height)
    throw new Error("Mask dimensions do not match");
  const counts = [0];
  let previous = 0;
  for (let x = 0; x < width; x++)
    for (let y = 0; y < height; y++) {
      const value = pixels[y * width + x] ? 1 : 0;
      if (value !== previous) {
        counts.push(0);
        previous = value;
      }
      counts[counts.length - 1]++;
    }
  return { size: [height, width], counts };
}

export function maskRGBA(rle, opacity = 0.2) {
  const { pixels, width, height } = decodeRLE(rle);
  const rgba = new Uint8ClampedArray(pixels.length * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!pixels[i]) continue;
      const edge =
        !x ||
        !y ||
        x === width - 1 ||
        y === height - 1 ||
        !pixels[i - 1] ||
        !pixels[i + 1] ||
        !pixels[i - width] ||
        !pixels[i + width];
      rgba.set([128, 220, 216, edge ? 255 : Math.round(255 * opacity)], i * 4);
    }
  return { rgba, width, height };
}
