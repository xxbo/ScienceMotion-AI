import { parseSvgPathData } from "./graphic-values";

export type Point2D = [number, number];
type Segment = { end: number; at(fraction: number): Point2D };
export interface MotionPath {
  readonly length: number;
  pointAt(progress: number): Point2D;
}

const infinity = () => new Error("Motion path contains non-finite coordinates or length");

/** A continuous open SVG subpath of straight lines and circular arcs, sampled by local arc length. */
export function compileMotionPath(data: unknown): MotionPath {
  const commands = parseSvgPathData(data);
  if (!commands) throw new Error("Motion path requires valid SVG path data");
  let current: Point2D = [0, 0], length = 0;
  const segments: Segment[] = [];
  const add = (span: number, at: Segment["at"]) => {
    const end = length + span;
    if (!Number.isFinite(end) || end <= length) throw infinity();
    segments.push({ end, at });
    length = end;
  };
  for (const [index, { command, args }] of commands.entries()) {
    const lower = command.toLowerCase(), relative = command === lower;
    const origin = current;
    const xy = (x: number, y: number): Point2D => relative ? [origin[0] + x, origin[1] + y] : [x, y];
    if (lower === "m") {
      if (index !== 0) throw new Error("Motion path must have only one continuous subpath");
      current = xy(args[0], args[1]);
      continue;
    }
    let target: Point2D;
    if (lower === "h") target = [args[0] + (relative ? origin[0] : 0), origin[1]];
    else if (lower === "v") target = [origin[0], args[0] + (relative ? origin[1] : 0)];
    else if (lower === "l") target = xy(args[0], args[1]);
    else if (lower === "a") target = xy(args[5], args[6]);
    else throw new Error("Motion path supports M, L, H, V and circular A commands");
    if (!target.every(Number.isFinite)) throw infinity();
    current = target;
    const dx = target[0] - origin[0], dy = target[1] - origin[1], chord = Math.hypot(dx, dy);
    if (!Number.isFinite(chord)) throw infinity();
    if (lower !== "a") {
      if (chord > 0) add(chord, t => t === 1 ? [...target] : [origin[0] + dx * t, origin[1] + dy * t]);
      continue;
    }

    const [rx, ry, , large, sweep] = args;
    if (!(rx > 0) || rx !== ry) throw new Error("Motion arcs must have equal positive X and Y radii");
    if (!chord) continue;
    // SVG endpoint-to-center conversion for circles. Expand short radii as SVG does.
    const radius = Math.max(rx, chord / 2);
    const halfChord = Math.min(1, (chord / radius) / 2);
    const shift = (large === sweep ? -1 : 1) * radius * Math.sqrt(Math.max(0, 1 - halfChord ** 2));
    const cx = origin[0] + dx / 2 - (dy / chord) * shift;
    const cy = origin[1] + dy / 2 + (dx / chord) * shift;
    const start = Math.atan2(origin[1] - cy, origin[0] - cx);
    const minor = 2 * Math.asin(halfChord);
    const delta = (sweep ? 1 : -1) * (large ? 2 * Math.PI - minor : minor);
    if (![cx, cy, start, delta].every(Number.isFinite)) throw infinity();
    add(Math.abs(delta) * radius, t => {
      if (t === 0) return [...origin];
      if (t === 1) return [...target];
      const angle = start + delta * t;
      return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
    });
  }
  if (!segments.length) throw new Error("Motion path must have a positive length");
  return {
    length,
    pointAt(progress) {
      if (!Number.isFinite(progress) || progress < 0 || progress > 1) throw new Error("Motion path progress must be in [0, 1]");
      const distance = progress * length;
      let lo = 0, hi = segments.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (segments[mid].end < distance) lo = mid + 1; else hi = mid;
      }
      const start = lo ? segments[lo - 1].end : 0, segment = segments[lo];
      const coordinate = segment.at((distance - start) / (segment.end - start));
      if (!coordinate.every(Number.isFinite)) throw infinity();
      return coordinate;
    },
  };
}
