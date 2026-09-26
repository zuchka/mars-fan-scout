const radToDeg = 180 / Math.PI;
export const wrapDegrees = degrees => ((degrees % 360) + 360) % 360;

// Area-weighted polygon moments avoid giving extra weight to jagged mask edges.
export function polygonAxis(points) {
  if (!Array.isArray(points) || points.length < 3) return null;
  let twiceArea = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i], [u, v] = points[(i + 1) % points.length];
    if (![x, y, u, v].every(Number.isFinite)) return null;
    const cross = x * v - u * y;
    twiceArea += cross;
    sx += (x + u) * cross;
    sy += (y + v) * cross;
    sxx += (x * x + x * u + u * u) * cross;
    syy += (y * y + y * v + v * v) * cross;
    sxy += (2 * x * y + x * v + u * y + 2 * u * v) * cross;
  }
  const area = twiceArea / 2;
  if (Math.abs(area) < 1) return null;
  const cx = sx / (6 * area), cy = sy / (6 * area);
  const xx = sxx / (12 * area) - cx * cx;
  const yy = syy / (12 * area) - cy * cy;
  const xy = sxy / (24 * area) - cx * cy;
  const delta = Math.hypot(xx - yy, 2 * xy);
  const major = (xx + yy + delta) / 2;
  const minor = (xx + yy - delta) / 2;
  if (!(major > 0) || !(minor > 0)) return null;
  const theta = Math.atan2(2 * xy, xx - yy) / 2;
  let ux = Math.cos(theta), uy = Math.sin(theta);
  if (ux < 0 || (Math.abs(ux) < 1e-8 && uy < 0)) { ux = -ux; uy = -uy; }
  const projections = points.map(([x, y]) => (x - cx) * ux + (y - cy) * uy).sort((a, b) => a - b);
  const quantile = q => {
    const position = q * (projections.length - 1), low = Math.floor(position);
    return projections[low] + (projections[Math.ceil(position)] - projections[low]) * (position - low);
  };
  const low = quantile(.05), high = quantile(.95);
  const span = high - low, elongation = Math.sqrt(major / minor);
  return {
    a: [cx + ux * low, cy + uy * low],
    b: [cx + ux * high, cy + uy * high],
    center: [cx, cy], span, elongation,
    usable: span >= 20 && elongation >= 1.5,
  };
}

export function directionEstimate(axis, sourceEnd, northImageDegrees = null) {
  if (!axis?.usable || !["a", "b"].includes(sourceEnd)) return null;
  const source = axis[sourceEnd], tip = axis[sourceEnd === "a" ? "b" : "a"];
  const imageDegrees = wrapDegrees(Math.atan2(tip[0] - source[0], source[1] - tip[1]) * radToDeg);
  const hasNorth = Number.isFinite(northImageDegrees);
  const towardDegrees = hasNorth ? wrapDegrees(imageDegrees - northImageDegrees) : null;
  return {
    source, tip, imageDegrees,
    towardDegrees,
    fromDegrees: hasNorth ? wrapDegrees(towardDegrees + 180) : null,
  };
}

export function circularSummary(degrees) {
  if (!degrees.length) return { count: 0, meanDegrees: null, agreement: null };
  const east = degrees.reduce((sum, value) => sum + Math.sin(value / radToDeg), 0);
  const north = degrees.reduce((sum, value) => sum + Math.cos(value / radToDeg), 0);
  const agreement = Math.hypot(east, north) / degrees.length;
  return {
    count: degrees.length,
    meanDegrees: degrees.length > 1 && agreement < .35 ? null : wrapDegrees(Math.atan2(east, north) * radToDeg),
    agreement,
  };
}

export function compassPoint(degrees) {
  const points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return points[Math.round(wrapDegrees(degrees) / 22.5) % points.length];
}
