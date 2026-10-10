export function bounds(points) {
  return {
    x: Math.min(...points.map((p) => p[0])),
    y: Math.min(...points.map((p) => p[1])),
    width:
      Math.max(...points.map((p) => p[0])) -
      Math.min(...points.map((p) => p[0])),
    height:
      Math.max(...points.map((p) => p[1])) -
      Math.min(...points.map((p) => p[1])),
  };
}
export function clipRegion(region, image) {
  const x = Math.max(0, Math.floor(region.x)),
    y = Math.max(0, Math.floor(region.y));
  const right = Math.min(image.width, Math.ceil(region.x + region.width)),
    bottom = Math.min(image.height, Math.ceil(region.y + region.height));
  if (
    ![x, y, right, bottom].every(Number.isFinite) ||
    right <= x ||
    bottom <= y
  )
    throw new Error("Region is outside the image");
  return { x, y, width: right - x, height: bottom - y };
}
export function tilesForRegion(
  region,
  scale = 1,
  tileSize = 1024,
  overlap = 128,
) {
  if (![1, 2, 4].includes(scale) || tileSize <= overlap || overlap < 0)
    throw new Error("Invalid tile settings");
  const size = tileSize * scale,
    stride = (tileSize - overlap) * scale;
  const starts = (length) => {
    const values = [0];
    while (values.at(-1) + size < length)
      values.push(Math.min(length - size, values.at(-1) + stride));
    return values;
  };
  return starts(region.height).flatMap((y) =>
    starts(region.width).map((x) => ({
      x: region.x + x,
      y: region.y + y,
      width: Math.min(size, region.width - x),
      height: Math.min(size, region.height - y),
      scale,
    })),
  );
}
export function mapPoints(points, region, input) {
  return points.map((p) => {
    const [x, y] = Array.isArray(p) ? p : [p.x, p.y];
    return [
      region.x + (Number(x) * region.width) / input.width,
      region.y + (Number(y) * region.height) / input.height,
    ];
  });
}
export function inside(point, polygon) {
  let hit = false;
  const [x, y] = point;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (
      a[1] > y !== b[1] > y &&
      x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]
    )
      hit = !hit;
  }
  return hit;
}
export function maskIoU(a, b) {
  const aa = bounds(a),
    bb = bounds(b),
    left = Math.min(aa.x, bb.x),
    top = Math.min(aa.y, bb.y),
    right = Math.max(aa.x + aa.width, bb.x + bb.width),
    bottom = Math.max(aa.y + aa.height, bb.y + bb.height);
  if (
    aa.x >= bb.x + bb.width ||
    bb.x >= aa.x + aa.width ||
    aa.y >= bb.y + bb.height ||
    bb.y >= aa.y + aa.height
  )
    return 0;
  let intersection = 0,
    union = 0;
  for (let y = 0; y < 48; y++)
    for (let x = 0; x < 48; x++) {
      const p = [
          left + ((x + 0.5) * (right - left)) / 48,
          top + ((y + 0.5) * (bottom - top)) / 48,
        ],
        av = inside(p, a),
        bv = inside(p, b);
      if (av || bv) union++;
      if (av && bv) intersection++;
    }
  return union ? intersection / union : 0;
}
export function mergeCandidates(items) {
  const kept = [];
  for (const item of [...items].sort(
    (a, b) =>
      Number(a.clipped) - Number(b.clipped) || b.confidence - a.confidence,
  )) {
    const match = kept.find(
      (other) =>
        other.tile_id !== item.tile_id &&
        maskIoU(other.polygon, item.polygon) > 0.55,
    );
    if (match) {
      match.duplicate_ids.push(item.id);
      continue;
    }
    kept.push({ ...item, duplicate_ids: [] });
  }
  return kept.sort(
    (a, b) =>
      b.confidence * Math.sqrt(b.area) - a.confidence * Math.sqrt(a.area),
  );
}
export function candidateRegion(candidate, image, expansion = 2.6) {
  const b = bounds(candidate.polygon),
    side = Math.ceil(Math.max(160, b.width, b.height) * expansion);
  return clipRegion(
    {
      x: b.x + b.width / 2 - side / 2,
      y: b.y + b.height / 2 - side / 2,
      width: side,
      height: side,
    },
    image,
  );
}
