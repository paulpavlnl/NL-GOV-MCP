/**
 * Small planar geometry helpers for putting one point on a map for a shape:
 * a point inside a polygon (also an L, a U, a ring with a hole or a
 * multipolygon), a point on a line, and area and length. Coordinates are
 * planar (RD metres). For lon/lat input use `inLocalMetres`, which projects
 * to a local metric plane and back, so distances are not stretched by the
 * longitude scale.
 *
 * Self-contained on purpose: no turf or polylabel dependency for what fits in
 * one file.
 */

export type Coord = [number, number];
/** A closed or open ring; the closing vertex may be repeated or not. */
export type Ring = Coord[];
/** Exterior ring first, holes after. */
export type Polygon = Ring[];

export type Geometry =
  | { type: "point"; points: Coord[] }
  | { type: "line"; lines: Coord[][] }
  | { type: "polygon"; polygons: Polygon[] };

// ---------------------------------------------------------------- parsing

function pairs(text: string): Coord[] {
  const out: Coord[] = [];
  for (const chunk of text.split(",")) {
    const [a, b] = chunk.trim().split(/\s+/).map(Number);
    if (Number.isFinite(a) && Number.isFinite(b)) out.push([a, b]);
  }
  return out;
}

/** "((a b, c d), (e f))" as nested arrays whose leaves are coordinate lists. */
function nested(text: string): unknown[] | undefined {
  let i = 0;
  const skip = (): void => {
    while (i < text.length && /\s/.test(text[i])) i += 1;
  };
  const list = (): unknown[] => {
    if (text[i] !== "(") throw new Error("expected (");
    i += 1;
    skip();
    if (text[i] !== "(") {
      const end = text.indexOf(")", i);
      if (end < 0) throw new Error("unclosed");
      const coords = pairs(text.slice(i, end));
      i = end + 1;
      return coords;
    }
    const children: unknown[] = [];
    for (;;) {
      skip();
      children.push(list());
      skip();
      if (text[i] === ",") {
        i += 1;
        continue;
      }
      if (text[i] === ")") {
        i += 1;
        return children;
      }
      throw new Error("expected , or )");
    }
  };
  try {
    skip();
    return list();
  } catch {
    return undefined;
  }
}

function asCoord(value: unknown): Coord | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const x = Number(value[0]);
  const y = Number(value[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : undefined;
}

function asCoords(value: unknown): Coord[] {
  return Array.isArray(value) ? value.map(asCoord).filter((c): c is Coord => c !== undefined) : [];
}

function asPolygon(value: unknown): Polygon | undefined {
  const rings = Array.isArray(value) ? value.map(asCoords) : [];
  if (!rings.length || rings[0].length < 3) return undefined;
  return [rings[0], ...rings.slice(1).filter((ring) => ring.length >= 3)];
}

function fromParts(kind: string, coordinates: unknown): Geometry | undefined {
  switch (kind) {
    case "POINT": {
      const point = asCoord(coordinates);
      return point ? { type: "point", points: [point] } : undefined;
    }
    case "MULTIPOINT": {
      const points = Array.isArray(coordinates) ? coordinates.map(asCoord).filter((c): c is Coord => c !== undefined) : [];
      return points.length ? { type: "point", points } : undefined;
    }
    case "LINESTRING": {
      const line = asCoords(coordinates);
      return line.length ? { type: "line", lines: [line] } : undefined;
    }
    case "MULTILINESTRING": {
      const lines = Array.isArray(coordinates) ? coordinates.map(asCoords).filter((line) => line.length) : [];
      return lines.length ? { type: "line", lines } : undefined;
    }
    case "POLYGON": {
      const polygon = asPolygon(coordinates);
      return polygon ? { type: "polygon", polygons: [polygon] } : undefined;
    }
    case "MULTIPOLYGON": {
      const polygons = Array.isArray(coordinates) ? coordinates.map(asPolygon).filter((p): p is Polygon => p !== undefined) : [];
      return polygons.length ? { type: "polygon", polygons } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Longest WKT text parseWkt reads (some 100,000 vertices); a longer one is
 * refused before any parsing.
 */
export const WKT_MAX_LENGTH = 4_000_000;

/** A WKT (Multi)Point, (Multi)LineString or (Multi)Polygon, in its own coordinate order. Z and M are dropped. */
export function parseWkt(wkt: string | undefined): Geometry | undefined {
  if (!wkt || wkt.length > WKT_MAX_LENGTH) return undefined;
  // The whitespace before Z/M belongs to one run only: two adjacent runs
  // around an optional group backtrack quadratically on a failing match.
  const match = /^\s*(MULTIPOLYGON|POLYGON|MULTILINESTRING|LINESTRING|MULTIPOINT|POINT)\s*(?:(?:ZM|Z|M)\s*)?(\(.*\))\s*$/is.exec(wkt);
  if (!match) return undefined;
  const kind = match[1].toUpperCase();
  if (kind === "POINT" || kind === "MULTIPOINT") {
    const points = pairs(match[2].replace(/[()]/g, ""));
    if (!points.length) return undefined;
    return { type: "point", points: kind === "POINT" ? points.slice(0, 1) : points };
  }
  const body = nested(match[2]);
  return body ? fromParts(kind, body) : undefined;
}

/** A GeoJSON geometry object. */
export function parseGeoJson(geometry: unknown): Geometry | undefined {
  if (!geometry || typeof geometry !== "object") return undefined;
  const { type, coordinates } = geometry as { type?: unknown; coordinates?: unknown };
  return typeof type === "string" ? fromParts(type.toUpperCase(), coordinates) : undefined;
}

/** Several geometries of one kind as one (the pieces of a road, the parts of an area). */
export function mergeGeometries(geometries: Array<Geometry | undefined>): Geometry | undefined {
  const present = geometries.filter((g): g is Geometry => g !== undefined);
  if (!present.length) return undefined;
  const polygons = present.flatMap((g) => (g.type === "polygon" ? g.polygons : []));
  if (polygons.length) return { type: "polygon", polygons };
  const lines = present.flatMap((g) => (g.type === "line" ? g.lines : []));
  if (lines.length) return { type: "line", lines };
  return { type: "point", points: present.flatMap((g) => (g.type === "point" ? g.points : [])) };
}

export function mapGeometry(geometry: Geometry, fn: (c: Coord) => Coord): Geometry {
  if (geometry.type === "point") return { type: "point", points: geometry.points.map(fn) };
  if (geometry.type === "line") return { type: "line", lines: geometry.lines.map((line) => line.map(fn)) };
  return { type: "polygon", polygons: geometry.polygons.map((polygon) => polygon.map((ring) => ring.map(fn))) };
}

/**
 * Run a planar computation on lon/lat coordinates: project to metres on a
 * plane tangent at the first vertex, compute, and project the resulting point
 * back. Exact inverse, so a point inside in metres is inside in degrees.
 */
export function inLocalMetres(geometry: Geometry, fn: (g: Geometry) => Coord | undefined): Coord | undefined {
  const first = geometry.type === "point" ? geometry.points[0] : geometry.type === "line" ? geometry.lines[0][0] : geometry.polygons[0][0][0];
  const [lon0, lat0] = first;
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180) || 1;
  const ky = 110_574;
  const result = fn(mapGeometry(geometry, ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky]));
  return result ? [result[0] / kx + lon0, result[1] / ky + lat0] : undefined;
}

// ---------------------------------------------------------------- measures

/** Signed shoelace area, relative to the first vertex against cancellation on large coordinates. */
function ringSignedArea(ring: Ring): number {
  const [ox, oy] = ring[0];
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    sum += (ring[j][0] - ox) * (ring[i][1] - oy) - (ring[i][0] - ox) * (ring[j][1] - oy);
  }
  return sum / 2;
}

/** Area of a polygon, holes subtracted. */
export function polygonArea(polygon: Polygon): number {
  const [outer, ...holes] = polygon;
  return Math.max(0, Math.abs(ringSignedArea(outer)) - holes.reduce((sum, hole) => sum + Math.abs(ringSignedArea(hole)), 0));
}

export function lineLength(line: Coord[]): number {
  let sum = 0;
  for (let i = 1; i < line.length; i += 1) sum += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  return sum;
}

/** Sum of the polygons' areas (holes subtracted); 0 for points and lines. */
export function geometryArea(geometry: Geometry): number {
  return geometry.type === "polygon" ? geometry.polygons.reduce((sum, polygon) => sum + polygonArea(polygon), 0) : 0;
}

/** Sum of the lines' lengths; 0 for points and polygons. */
export function geometryLength(geometry: Geometry): number {
  return geometry.type === "line" ? geometry.lines.reduce((sum, line) => sum + lineLength(line), 0) : 0;
}

// ---------------------------------------------------------------- inside

function inRing([x, y]: Coord, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside the exterior ring and outside every hole. */
export function pointInPolygon(point: Coord, polygon: Polygon): boolean {
  return inRing(point, polygon[0]) && !polygon.slice(1).some((hole) => inRing(point, hole));
}

export function pointInGeometry(point: Coord, geometry: Geometry): boolean {
  return geometry.type === "polygon" && geometry.polygons.some((polygon) => pointInPolygon(point, polygon));
}

// ---------------------------------------------------------------- points

/** Area centroid of a polygon with its holes; the vertex average for a degenerate one. */
export function polygonCentroid(polygon: Polygon): Coord {
  const [ox, oy] = polygon[0][0];
  let area = 0;
  let mx = 0;
  let my = 0;
  polygon.forEach((ring, index) => {
    let a = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const xj = ring[j][0] - ox;
      const yj = ring[j][1] - oy;
      const xi = ring[i][0] - ox;
      const yi = ring[i][1] - oy;
      const cross = xj * yi - xi * yj;
      a += cross / 2;
      cx += ((xj + xi) * cross) / 6;
      cy += ((yj + yi) * cross) / 6;
    }
    // Orientation-free: the exterior adds, a hole subtracts.
    const sign = (a < 0 ? -1 : 1) * (index === 0 ? 1 : -1);
    area += sign * a;
    mx += sign * cx;
    my += sign * cy;
  });
  if (Math.abs(area) <= 1e-12) {
    const outer = polygon[0];
    return [outer.reduce((sum, [x]) => sum + x, 0) / outer.length, outer.reduce((sum, [, y]) => sum + y, 0) / outer.length];
  }
  return [mx / area + ox, my / area + oy];
}

function segmentDistance([x, y]: Coord, [ax, ay]: Coord, [bx, by]: Coord): { distance: number; point: Coord } {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared)) : 0;
  const point: Coord = [ax + t * dx, ay + t * dy];
  return { distance: Math.hypot(x - point[0], y - point[1]), point };
}

/**
 * Distance to the polygon's boundary: positive inside, negative outside. One
 * pass over the vertices for both the distance (as segmentDistance; compared
 * squared, the nearest one measured with hypot) and the inside test (as
 * pointInPolygon), without allocating per segment: this loop is where the
 * interior-point search spends its time.
 */
function signedDistance([x, y]: Coord, polygon: Polygon): number {
  let min = Infinity; // squared
  let nearX = Infinity;
  let nearY = Infinity;
  let inOuter = false;
  let inHole = false;
  for (let r = 0; r < polygon.length; r += 1) {
    const ring = polygon[r];
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      const dx = xi - xj;
      const dy = yi - yj;
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared ? Math.max(0, Math.min(1, ((x - xj) * dx + (y - yj) * dy) / lengthSquared)) : 0;
      const ex = x - (xj + t * dx);
      const ey = y - (yj + t * dy);
      const squared = ex * ex + ey * ey;
      if (squared < min) {
        min = squared;
        nearX = ex;
        nearY = ey;
      }
    }
    if (r === 0) inOuter = inside;
    else if (inside) inHole = true;
  }
  return (inOuter && !inHole ? 1 : -1) * Math.hypot(nearX, nearY);
}

/**
 * Vertex visits (one per vertex per signedDistance) left for finding one
 * interior point: shared by both polylabel passes and the scanline fallbacks,
 * so a polygon with many vertices gets fewer cells instead of more work.
 */
interface WorkBudget {
  left: number;
}

interface Cell {
  x: number;
  y: number;
  half: number;
  distance: number;
  /** Best distance any point in this cell could have. */
  max: number;
}

function cell(x: number, y: number, half: number, polygon: Polygon): Cell {
  const distance = signedDistance([x, y], polygon);
  return { x, y, half, distance, max: distance + half * Math.SQRT2 };
}

/** A max-heap on Cell.max. */
class CellQueue {
  private readonly items: Cell[] = [];
  get size(): number {
    return this.items.length;
  }
  push(item: Cell): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent].max >= items[i].max) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }
  pop(): Cell | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length && last) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let largest = i;
        if (left < items.length && items[left].max > items[largest].max) largest = left;
        if (right < items.length && items[right].max > items[largest].max) largest = right;
        if (largest === i) break;
        [items[largest], items[i]] = [items[i], items[largest]];
        i = largest;
      }
    }
    return top;
  }
}

/** Cells looked at before polylabel settles for the best so far, the initial grid included. */
const POLYLABEL_MAX_CELLS = 20_000;
/** Cells of the initial grid along the longer bbox side, at most. */
const POLYLABEL_GRID_CELLS = 64;
/**
 * Vertex visits one interior-point search may spend, both polylabel passes and
 * the scanlines together: some tens of milliseconds whatever the vertex count
 * or shape.
 */
const INTERIOR_POINT_WORK = 3_000_000;
/** Scanlines across the polygon in the last fallback; fewer when the budget is spent, never fewer than the minimum. */
const SCANLINES = 64;
const SCANLINES_MIN = 8;

/**
 * The pole of inaccessibility: the point inside the polygon farthest from its
 * boundary, to within `precision` (default 1% of the shorter bbox side). The
 * grid search of Agafonkin's polylabel (Mapbox, 2016), written out here.
 */
export function polylabel(polygon: Polygon, precision?: number): Coord {
  return poleSearch(polygon, precision, { left: INTERIOR_POINT_WORK }).point;
}

/**
 * polylabel within a work budget, which it draws down; and whether it stopped
 * on its cell limit or the budget with cells left to look at.
 */
function poleSearch(polygon: Polygon, precision: number | undefined, budget: WorkBudget): { point: Coord; exhausted: boolean } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of polygon[0]) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const width = maxX - minX;
  const height = maxY - minY;
  const size = Math.min(width, height);
  if (size <= 0) return { point: [minX, minY], exhausted: false };
  const tolerance = precision ?? size / 100;
  let segments = 0;
  for (const ring of polygon) segments += ring.length;
  const make = (x: number, y: number, h: number): Cell => {
    budget.left -= segments;
    return cell(x, y, h, polygon);
  };
  const affordable = (cells: number): boolean => budget.left >= cells * segments;

  // Square cells of the shorter side, but at most POLYLABEL_GRID_CELLS along
  // the longer one: a thin strip would otherwise need width/height cells. The
  // column and row counters also end the loops when the step is below the
  // floating-point resolution of the coordinates and x += side stops advancing.
  const queue = new CellQueue();
  const side = Math.max(size, Math.max(width, height) / POLYLABEL_GRID_CELLS);
  const half = side / 2;
  const columns = Math.ceil(width / side) + 1;
  const rows = Math.ceil(height / side) + 1;
  let seen = 0;
  for (let x = minX, i = 0; x < maxX && i < columns && seen < POLYLABEL_MAX_CELLS && affordable(1); x += side, i += 1) {
    for (let y = minY, j = 0; y < maxY && j < rows && seen < POLYLABEL_MAX_CELLS && affordable(1); y += side, j += 1, seen += 1) {
      queue.push(make(x + half, y + half, half));
    }
  }
  const centroid = polygonCentroid(polygon);
  let best = make(centroid[0], centroid[1], 0);
  const middle = make(minX + width / 2, minY + height / 2, 0);
  if (middle.distance > best.distance) best = middle;

  while (queue.size && seen < POLYLABEL_MAX_CELLS && affordable(4)) {
    const current = queue.pop()!;
    seen += 1;
    if (current.distance > best.distance) best = current;
    if (current.max - best.distance <= tolerance) continue;
    const h = current.half / 2;
    queue.push(make(current.x - h, current.y - h, h));
    queue.push(make(current.x + h, current.y - h, h));
    queue.push(make(current.x - h, current.y + h, h));
    queue.push(make(current.x + h, current.y + h, h));
  }
  return { point: [best.x, best.y], exhausted: queue.size > 0 };
}

/** The middle of the widest stretch of the polygon on the horizontal line through y. */
function scanlinePoint(polygon: Polygon, y: number): Coord | undefined {
  const crossings: number[] = [];
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y) crossings.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
    }
  }
  crossings.sort((a, b) => a - b);
  let best: Coord | undefined;
  let widest = -1;
  for (let k = 0; k + 1 < crossings.length; k += 2) {
    const width = crossings[k + 1] - crossings[k];
    if (width > widest) {
      widest = width;
      best = [(crossings[k] + crossings[k + 1]) / 2, y];
    }
  }
  return best;
}

/** The widest horizontal stretch over a number of scanlines across the polygon's height. */
function widestScanlinePoint(polygon: Polygon, lines = SCANLINES): Coord | undefined {
  // A loop, not Math.min(...ys): spreading a ring of some 100k vertices overflows the stack.
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of polygon[0]) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  let best: Coord | undefined;
  let widest = -1;
  for (let k = 1; k <= lines; k += 1) {
    const y = minY + ((maxY - minY) * k) / (lines + 1);
    const point = scanlinePoint(polygon, y);
    if (!point || !pointInPolygon(point, polygon)) continue;
    const width = signedDistance(point, polygon);
    if (width > widest) {
      widest = width;
      best = point;
    }
  }
  return best;
}

/**
 * The area centroid when it lies inside the polygon (not in a hole), else its
 * pole of inaccessibility. For a strip much thinner than its bbox, where the
 * pole search can stop on a point just outside, a finer search and then
 * scanlines across the polygon make sure the point lands inside. All of it
 * within one work budget (INTERIOR_POINT_WORK): the finer search does not
 * start once the first has spent it, and keeps back what the scanlines need.
 */
export function polygonInteriorPoint(polygon: Polygon): Coord {
  const centroid = polygonCentroid(polygon);
  if (pointInPolygon(centroid, polygon)) return centroid;
  let vertices = 0;
  for (const ring of polygon) vertices += ring.length;
  // One scanline costs about three passes over the vertices.
  const scanlineCost = 3 * vertices;
  const budget: WorkBudget = { left: INTERIOR_POINT_WORK };
  const search = poleSearch(polygon, undefined, budget);
  const pole = search.point;
  if (pointInPolygon(pole, polygon)) return pole;
  // A search that ran out of cells or budget runs out again with precision 0; the scanlines below are cheap.
  const reserve = Math.min(budget.left, SCANLINES * scanlineCost);
  if (!search.exhausted && budget.left - reserve >= 4 * vertices) {
    const finer = poleSearch(polygon, 0, { left: budget.left - reserve }).point;
    if (pointInPolygon(finer, polygon)) return finer;
  }
  const scan = scanlinePoint(polygon, centroid[1]);
  if (scan && pointInPolygon(scan, polygon)) return scan;
  const lines = Math.max(SCANLINES_MIN, Math.min(SCANLINES, Math.floor(reserve / scanlineCost)));
  return widestScanlinePoint(polygon, lines) ?? pole;
}

/** The largest part of a multipolygon (by area, holes subtracted). */
export function largestPolygon(polygons: Polygon[]): Polygon {
  return polygons.reduce((largest, polygon) => (polygonArea(polygon) > polygonArea(largest) ? polygon : largest));
}

/** A point inside the largest part: its centroid when inside, else its pole of inaccessibility. */
export function interiorPoint(polygons: Polygon[]): Coord | undefined {
  return polygons.length ? polygonInteriorPoint(largestPolygon(polygons)) : undefined;
}

/** The point halfway along a line. */
export function midpointOfLine(line: Coord[]): Coord {
  let remaining = lineLength(line) / 2;
  for (let i = 0; i + 1 < line.length; i += 1) {
    const length = Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
    if (length > 0 && remaining <= length) {
      const t = remaining / length;
      return [line[i][0] + t * (line[i + 1][0] - line[i][0]), line[i][1] + t * (line[i + 1][1] - line[i][1])];
    }
    remaining -= length;
  }
  return line[line.length - 1];
}

/** The point on any of the lines nearest to `target`. */
export function nearestPointOnLines(lines: Coord[][], target: Coord): Coord {
  let best: Coord = lines[0][0];
  let bestDistance = Math.hypot(target[0] - best[0], target[1] - best[1]);
  for (const line of lines) {
    for (let i = 1; i < line.length; i += 1) {
      const { distance, point } = segmentDistance(target, line[i - 1], line[i]);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = point;
      }
    }
  }
  return best;
}

/** Length-weighted centroid of all segments of all lines. */
function lineCentroid(lines: Coord[][]): Coord | undefined {
  let total = 0;
  let sx = 0;
  let sy = 0;
  for (const line of lines) {
    for (let i = 1; i < line.length; i += 1) {
      const length = Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
      total += length;
      sx += ((line[i][0] + line[i - 1][0]) / 2) * length;
      sy += ((line[i][1] + line[i - 1][1]) / 2) * length;
    }
  }
  return total > 0 ? [sx / total, sy / total] : undefined;
}

/**
 * One point for a whole geometry, all its pieces counted:
 * - points: the first;
 * - one line: halfway along it; several pieces (a road sent as many
 *   segments): the point on the lines nearest their length-weighted centroid;
 * - polygons: the area centroid of all parts together when it lies inside one
 *   of them (not in a hole), else a point inside the largest part.
 */
export function representativePoint(geometry: Geometry): Coord | undefined {
  if (geometry.type === "point") return geometry.points[0];
  if (geometry.type === "line") {
    const lines = geometry.lines.filter((line) => lineLength(line) > 0);
    if (!lines.length) return geometry.lines[0]?.[0];
    if (lines.length === 1) return midpointOfLine(lines[0]);
    const centroid = lineCentroid(lines);
    return centroid ? nearestPointOnLines(lines, centroid) : lines[0][0];
  }
  const { polygons } = geometry;
  if (polygons.length === 1) return polygonInteriorPoint(polygons[0]);
  let area = 0;
  let sx = 0;
  let sy = 0;
  for (const polygon of polygons) {
    const a = polygonArea(polygon);
    if (a <= 0) continue;
    const [cx, cy] = polygonCentroid(polygon);
    area += a;
    sx += cx * a;
    sy += cy * a;
  }
  if (area > 0) {
    const centroid: Coord = [sx / area, sy / area];
    if (polygons.some((polygon) => pointInPolygon(centroid, polygon))) return centroid;
  }
  return interiorPoint(polygons);
}
