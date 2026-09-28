export function polygonArea(points) {
  return Math.abs(points.reduce((sum, [x, y], index) => {
    const [nextX, nextY] = points[(index + 1) % points.length];
    return sum + x * nextY - nextX * y;
  }, 0)) / 2;
}

function bounds(points) {
  return { left: Math.min(...points.map(point => point[0])), top: Math.min(...points.map(point => point[1])),
    right: Math.max(...points.map(point => point[0])), bottom: Math.max(...points.map(point => point[1])) };
}

function boxIoU(a, b) {
  const overlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const area = value => (value.right - value.left) * (value.bottom - value.top);
  return overlap / Math.max(1, area(a) + area(b) - overlap);
}

export function predictionsFromRoboflow(data, { width, height }) {
  const imageWidth = Number(data.image?.width) || width;
  const imageHeight = Number(data.image?.height) || height;
  const normalized = (Array.isArray(data.predictions) ? data.predictions : []).map((item, sourceIndex) => {
    const hasBox = [item.x, item.y, item.width, item.height].every(value => Number.isFinite(Number(value))) && Number(item.width) > 0 && Number(item.height) > 0;
    const box = hasBox ? [[Number(item.x) - Number(item.width) / 2, Number(item.y) - Number(item.height) / 2],
      [Number(item.x) + Number(item.width) / 2, Number(item.y) - Number(item.height) / 2],
      [Number(item.x) + Number(item.width) / 2, Number(item.y) + Number(item.height) / 2],
      [Number(item.x) - Number(item.width) / 2, Number(item.y) + Number(item.height) / 2]] : [];
    const raw = Array.isArray(item.points) && item.points.length >= 3 ? item.points
      : Array.isArray(item.polygon) && item.polygon.length >= 3 ? item.polygon : box;
    const polygon = raw.map(point => Array.isArray(point) ? point : [point.x, point.y])
      .map(([x, y]) => [Math.max(0, Math.min(width, Number(x) * width / imageWidth)), Math.max(0, Math.min(height, Number(y) * height / imageHeight))])
      .filter(point => point.every(Number.isFinite));
    const confidence = Number(item.confidence);
    if (polygon.length < 3 || !Number.isFinite(confidence) || confidence < .2) return null;
    return { polygon, confidence, bounds: bounds(polygon), area: polygonArea(polygon), sourceIndex };
  }).filter(Boolean).sort((a, b) => b.confidence - a.confidence);
  const unique = [];
  for (const item of normalized) if (!unique.some(other => boxIoU(item.bounds, other.bounds) > .42)) unique.push(item);
  return unique;
}

export function showcaseCandidates(items, { width, height }, count = 3) {
  const minArea = Math.max(50, width * height * .0005);
  const eligible = items.filter(item => item.area >= minArea &&
    item.bounds.right - item.bounds.left >= 8 && item.bounds.bottom - item.bounds.top >= 8);
  const selected = [];
  const diagonal = Math.hypot(width, height);
  while (selected.length < count && eligible.length) {
    const score = item => {
      const cx = (item.bounds.left + item.bounds.right) / 2;
      const cy = (item.bounds.top + item.bounds.bottom) / 2;
      const distance = selected.length ? Math.min(...selected.map(other => Math.hypot(cx - (other.bounds.left + other.bounds.right) / 2,
        cy - (other.bounds.top + other.bounds.bottom) / 2))) / diagonal : 1;
      const edge = item.bounds.left <= 1 || item.bounds.top <= 1 || item.bounds.right >= width - 1 || item.bounds.bottom >= height - 1;
      return item.confidence * Math.sqrt(item.area) * (edge ? .65 : 1) * (.72 + .28 * Math.min(1, distance * 2));
    };
    eligible.sort((a, b) => score(b) - score(a) || b.confidence - a.confidence);
    const winner = eligible.shift();
    selected.push(winner);
    for (let index = eligible.length - 1; index >= 0; index--) {
      if (boxIoU(winner.bounds, eligible[index].bounds) > .18) eligible.splice(index, 1);
    }
  }
  return selected;
}
