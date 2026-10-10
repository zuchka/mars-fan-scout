import { inside } from "./geometry.js";
function quantile(values, p) {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  return values[
    Math.min(values.length - 1, Math.floor(p * (values.length - 1)))
  ];
}
export function estimateFringe({
  gray,
  width,
  height,
  polygon,
  points = [],
  sensitivity = 0.45,
}) {
  const n = width * height;
  if (
    ![width, height].every((v) => Number.isInteger(v) && v > 0) ||
    gray.length !== n ||
    n > 1_048_576
  )
    throw new Error("Invalid analysis grid");
  const smooth = new Float32Array(n),
    core = new Uint8Array(n),
    signal = new Float32Array(n),
    alpha = new Uint8Array(n),
    blocked = new Uint8Array(n);
  const backgrounds = [],
    interior = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let sum = 0,
        count = 0;
      for (let yy = Math.max(0, y - 2); yy <= Math.min(height - 1, y + 2); yy++)
        for (
          let xx = Math.max(0, x - 2);
          xx <= Math.min(width - 1, x + 2);
          xx++
        ) {
          sum += gray[yy * width + xx];
          count++;
        }
      smooth[i] = sum / count;
      core[i] = inside([x + 0.5, y + 0.5], polygon) ? 1 : 0;
      if (core[i]) interior.push(smooth[i]);
      else if (
        x < width * 0.12 ||
        x > width * 0.88 ||
        y < height * 0.12 ||
        y > height * 0.88
      )
        backgrounds.push(smooth[i]);
    }
  const background = quantile(backgrounds, 0.6),
    foreground = quantile(interior, 0.35),
    amplitude = Math.max(8, background - foreground);
  const lo = Math.max(0.08, 0.5 - 0.4 * sensitivity),
    hi = 0.65,
    queue = new Int32Array(n);
  let head = 0,
    tail = 0;
  for (let i = 0; i < n; i++)
    signal[i] = Math.max(0, Math.min(1, (background - smooth[i]) / amplitude));
  for (const point of points.filter((p) => p.label === "exclude"))
    for (
      let y = Math.max(0, Math.round(point.y) - 5);
      y <= Math.min(height - 1, Math.round(point.y) + 5);
      y++
    )
      for (
        let x = Math.max(0, Math.round(point.x) - 5);
        x <= Math.min(width - 1, Math.round(point.x) + 5);
        x++
      )
        blocked[y * width + x] = 1;
  const seed = (i) => {
    if (!blocked[i] && !alpha[i]) {
      alpha[i] = Math.max(1, Math.round(signal[i] * 255));
      queue[tail++] = i;
    }
  };
  for (let i = 0; i < n; i++) if (core[i] && signal[i] >= hi) seed(i);
  for (const p of points.filter((p) => p.label === "include")) {
    const x = Math.round(p.x),
      y = Math.round(p.y);
    if (x >= 0 && y >= 0 && x < width && y < height) seed(y * width + x);
  }
  while (head < tail) {
    const i = queue[head++],
      x = i % width,
      y = Math.floor(i / width);
    for (const j of [
      x > 0 ? i - 1 : -1,
      x < width - 1 ? i + 1 : -1,
      y > 0 ? i - width : -1,
      y < height - 1 ? i + width : -1,
    ])
      if (j >= 0 && !alpha[j] && !blocked[j] && signal[j] >= lo) seed(j);
  }
  let edge = false,
    coreCount = 0;
  for (let i = 0; i < n; i++) {
    if (core[i]) coreCount++;
    if (
      alpha[i] &&
      (i < width ||
        i >= n - width ||
        i % width === 0 ||
        i % width === width - 1)
    )
      edge = true;
  }
  const areaAt = (threshold) => {
    const seen = new Uint8Array(n),
      pending = new Int32Array(n);
    let start = 0,
      end = 0;
    const add = (i) => {
      if (!seen[i] && !blocked[i]) {
        seen[i] = 1;
        pending[end++] = i;
      }
    };
    for (let i = 0; i < n; i++) if (core[i] && signal[i] >= hi) add(i);
    for (const p of points.filter((p) => p.label === "include")) {
      const x = Math.round(p.x),
        y = Math.round(p.y);
      if (x >= 0 && y >= 0 && x < width && y < height) add(y * width + x);
    }
    while (start < end) {
      const i = pending[start++],
        x = i % width,
        y = Math.floor(i / width);
      for (const j of [
        x > 0 ? i - 1 : -1,
        x < width - 1 ? i + 1 : -1,
        y > 0 ? i - width : -1,
        y < height - 1 ? i + width : -1,
      ])
        if (j >= 0 && !seen[j] && !blocked[j] && signal[j] >= threshold) add(j);
    }
    return end;
  };
  const stability = {
    threshold_delta: 0.04,
    conservative_area: areaAt(lo + 0.04),
    permissive_area: areaAt(Math.max(0.04, lo - 0.04)),
    selected_area: tail,
  };
  const warnings = [];
  if (background - foreground < 8)
    warnings.push(
      "Weak contrast: the source and local background are hard to separate",
    );
  if (!tail) warnings.push("No connected dark seed survived");
  if (edge)
    warnings.push(
      "Estimated extent touches the crop boundary; inspect a wider context",
    );
  if (tail > coreCount * 4)
    warnings.push("Large expansion may include terrain or another deposit");
  if (
    (stability.permissive_area - stability.conservative_area) /
      Math.max(1, tail) >
    0.35
  )
    warnings.push(
      "Unstable extent: a small threshold change alters area by more than 35%",
    );
  return {
    alpha,
    width,
    height,
    background,
    foreground,
    sensitivity,
    threshold: lo,
    warnings,
    stability,
    method: "seed-connected local contrast v1",
    meaning:
      "relative dark signal connected to proposed or edited seeds; not probability or dust density",
  };
}
