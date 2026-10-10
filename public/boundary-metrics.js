import { decodeRLE } from "./masks.js";
import { bounds, inside } from "./geometry.js";

export function rasterGeometry(
  geometry,
  width,
  height,
  region = { x: 0, y: 0, width, height },
) {
  const output = new Uint8Array(width * height);
  if (geometry.rle) {
    const mask = decodeRLE(geometry.rle),
      r = geometry.region || region;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const sx = region.x + ((x + 0.5) * region.width) / width,
          sy = region.y + ((y + 0.5) * region.height) / height;
        const mx = Math.floor(((sx - r.x) * mask.width) / r.width),
          my = Math.floor(((sy - r.y) * mask.height) / r.height);
        if (mx >= 0 && my >= 0 && mx < mask.width && my < mask.height)
          output[y * width + x] = mask.pixels[my * mask.width + mx];
      }
  } else {
    for (const polygon of geometry.polygons ||
      (geometry.polygon ? [geometry.polygon] : [])) {
      if (
        !Array.isArray(polygon) ||
        polygon.length < 3 ||
        !polygon.every(
          (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite),
        )
      )
        throw new Error("Invalid polygon");
      const b = bounds(polygon),
        left = Math.max(
          0,
          Math.floor(((b.x - region.x) * width) / region.width),
        ),
        top = Math.max(
          0,
          Math.floor(((b.y - region.y) * height) / region.height),
        ),
        right = Math.min(
          width,
          Math.ceil(((b.x + b.width - region.x) * width) / region.width),
        ),
        bottom = Math.min(
          height,
          Math.ceil(((b.y + b.height - region.y) * height) / region.height),
        );
      for (let y = top; y < bottom; y++)
        for (let x = left; x < right; x++)
          if (
            inside(
              [
                region.x + ((x + 0.5) * region.width) / width,
                region.y + ((y + 0.5) * region.height) / height,
              ],
              polygon,
            )
          )
            output[y * width + x] = 1;
    }
  }
  return output;
}

export function boundaryMetrics(
  prediction,
  core,
  envelope,
  unknown,
  width,
  height,
  visible = null,
  tolerance = 2,
) {
  let corePixels = 0,
    missed = 0,
    predicted = 0,
    leaked = 0,
    tp = 0,
    fp = 0,
    fn = 0,
    evaluable = 0;
  for (let i = 0; i < core.length; i++) {
    if (unknown[i]) continue;
    if (core[i]) {
      corePixels++;
      if (!prediction[i]) missed++;
    }
    if (prediction[i]) {
      predicted++;
      if (!envelope[i]) leaked++;
    }
    // Without an explicit visible boundary, the core/envelope band is unknown.
    if (!visible && envelope[i] && !core[i]) continue;
    evaluable++;
    const actual = visible ? visible[i] : core[i];
    if (actual && prediction[i]) tp++;
    else if (prediction[i]) fp++;
    else if (actual) fn++;
  }
  const ratio = (a, b) => (b ? a / b : null);
  const result = {
    core_pixels: corePixels,
    core_omission: ratio(missed, corePixels),
    predicted_evaluable_pixels: predicted,
    background_leakage: ratio(leaked, predicted),
    evaluable_pixels: evaluable,
    iou: ratio(tp, tp + fp + fn),
    dice: ratio(2 * tp, 2 * tp + fp + fn),
    boundary_f1: null,
  };
  if (visible) {
    const edge = (mask) => {
      const result = new Uint8Array(mask.length);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          if (unknown[i] || !mask[i]) continue;
          let ambiguous = false;
          for (
            let yy = Math.max(0, y - tolerance);
            yy <= Math.min(height - 1, y + tolerance) && !ambiguous;
            yy++
          )
            for (
              let xx = Math.max(0, x - tolerance);
              xx <= Math.min(width - 1, x + tolerance);
              xx++
            )
              if (unknown[yy * width + xx]) {
                ambiguous = true;
                break;
              }
          if (
            !ambiguous &&
            (!x ||
              !y ||
              x === width - 1 ||
              y === height - 1 ||
              !mask[i - 1] ||
              !mask[i + 1] ||
              !mask[i - width] ||
              !mask[i + width])
          )
            result[i] = 1;
        }
      return result;
    };
    const a = edge(prediction),
      b = edge(visible);
    const matched = (one, two) => {
      let total = 0,
        match = 0;
      for (let i = 0; i < one.length; i++)
        if (one[i]) {
          total++;
          const x = i % width,
            y = Math.floor(i / width);
          let hit = false;
          for (
            let yy = Math.max(0, y - tolerance);
            yy <= Math.min(height - 1, y + tolerance) && !hit;
            yy++
          )
            for (
              let xx = Math.max(0, x - tolerance);
              xx <= Math.min(width - 1, x + tolerance);
              xx++
            )
              if (
                (xx - x) ** 2 + (yy - y) ** 2 <= tolerance ** 2 &&
                two[yy * width + xx]
              ) {
                hit = true;
                break;
              }
          if (hit) match++;
        }
      return ratio(match, total);
    };
    const precision = matched(a, b),
      recall = matched(b, a);
    result.boundary_f1 =
      precision === null && recall === null
        ? null
        : precision === null || recall === null
          ? 0
          : precision + recall
            ? (2 * precision * recall) / (precision + recall)
            : 0;
  }
  return result;
}

export function validateAnnotation(annotation, { complete = true } = {}) {
  if (annotation.format !== "mars-boundary-review-v1")
    throw new Error("Expected mars-boundary-review-v1");
  const s = annotation.source;
  if (
    !s ||
    ![s.width, s.height].every((n) => Number.isInteger(n) && n > 0) ||
    s.width * s.height > 16_777_216 ||
    !/^[a-f0-9]{64}$/.test(s.original_sha256 || "") ||
    !s.observation
  )
    throw new Error("Source hash, dimensions, and observation are required");
  if (
    complete &&
    (!annotation.coverage_complete ||
      !annotation.reviewer ||
      !annotation.second_reviewer ||
      annotation.reviewer === annotation.second_reviewer)
  )
    throw new Error(
      "Scoring requires complete image coverage and two identified reviewers",
    );
  if (!Array.isArray(annotation.instances))
    throw new Error(
      "Instances are required, including an explicit empty array for reviewed negatives",
    );
  const ids = new Set();
  for (const instance of annotation.instances) {
    if (
      !instance.id ||
      ids.has(instance.id) ||
      !["fan", "lookalike", "uncertain"].includes(instance.class)
    )
      throw new Error("Each instance needs a unique ID and class");
    ids.add(instance.id);
    if (!instance.core || !instance.envelope)
      throw new Error("Every instance needs core and envelope geometry");
    const core = rasterGeometry(instance.core, s.width, s.height),
      envelope = rasterGeometry(instance.envelope, s.width, s.height);
    if (!envelope.some(Boolean))
      throw new Error(`Empty envelope for ${instance.id}`);
    if (instance.class === "fan" && !core.some(Boolean))
      throw new Error(`A definite fan needs a nonempty core: ${instance.id}`);
    if (core.some((v, i) => v && !envelope[i]))
      throw new Error(`Core is outside envelope for ${instance.id}`);
    if (instance.visible) {
      const visible = rasterGeometry(instance.visible, s.width, s.height);
      if (
        visible.some((v, i) => v && !envelope[i]) ||
        core.some((v, i) => v && !visible[i])
      )
        throw new Error(
          `Visible mask must contain core and fit envelope: ${instance.id}`,
        );
    }
  }
  return annotation;
}

export function matchInstances(predictions, truth, threshold = 0.25) {
  // Maximum-cardinality one-to-one matching; strongest overlap tried first.
  const overlap = (a, b) => {
    let intersection = 0,
      union = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] && b[i]) intersection++;
      if (a[i] || b[i]) union++;
    }
    return union ? intersection / union : 0;
  };
  const neighbors = predictions.map((p) =>
    truth
      .map((t, i) => ({ i, iou: overlap(p, t) }))
      .filter((x) => x.iou >= threshold)
      .sort((a, b) => b.iou - a.iou),
  );
  const owners = new Map();
  const assign = (p, seen) => {
    for (const { i } of neighbors[p])
      if (!seen.has(i)) {
        seen.add(i);
        if (!owners.has(i) || assign(owners.get(i), seen)) {
          owners.set(i, p);
          return true;
        }
      }
    return false;
  };
  predictions.forEach((_, i) => assign(i, new Set()));
  return [...owners].map(([truth, prediction]) => ({
    truth,
    prediction,
    iou: neighbors[prediction].find((n) => n.i === truth).iou,
  }));
}
