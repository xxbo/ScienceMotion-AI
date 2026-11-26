import assert from "node:assert/strict";
import type { Vector3 } from "../../src/contracts/project";

export const threeProfile = { width: 640, height: 360, fps: 24 };
export const threeStaticCamera: { position: Vector3; rotation: Vector3 } = { position: [0, 2.3, 8], rotation: [-14, 0, 0] };
const { width, height } = threeProfile;

// Independent pinhole projections for the pinned scene. No renderer math or captured pixels determine the targets.
type Bounds = [left: number, top: number, right: number, bottom: number];
const rad = (deg: number) => deg * Math.PI / 180;
const rx = ([x, y, z]: Vector3, deg: number): Vector3 => [x, y * Math.cos(rad(deg)) - z * Math.sin(rad(deg)), y * Math.sin(rad(deg)) + z * Math.cos(rad(deg))];
const ry = ([x, y, z]: Vector3, deg: number): Vector3 => [x * Math.cos(rad(deg)) + z * Math.sin(rad(deg)), y, -x * Math.sin(rad(deg)) + z * Math.cos(rad(deg))];
const rz = ([x, y, z]: Vector3, deg: number): Vector3 => [x * Math.cos(rad(deg)) - y * Math.sin(rad(deg)), x * Math.sin(rad(deg)) + y * Math.cos(rad(deg)), z];
const focus = height / (2 * Math.tan(rad(38 / 2)));
const project = ([x, y, z]: Vector3) => [width / 2 + focus * x / -z, height / 2 - focus * y / -z];
export function projectThreeBounds({ position: [cx, cy, cz], rotation: [ax, ay, az] } = threeStaticCamera): { box: Bounds; sphere: Bounds } {
  const view = ([x, y, z]: Vector3) => rz(ry(rx([x - cx, y - cy, z - cz], -ax), -ay), -az);
  const corners = [-1, 1].flatMap(a => [-1, 1].flatMap(b => [-1, 1].map(c => {
    const [x, y, z] = rx(ry(rz([a * 0.9 * 1.1, b * 0.8, c * 0.7 * 0.9], -10), 30), 12);
    return project(view([x - 1.35, y, z]));
  })));
  const [sx, sy, sz] = view([1.35, 0, -0.2]);
  const tangent = (axis: number, sign: -1 | 1) => (axis * -sz + sign * Math.sqrt(sz * sz + axis * axis - 1)) / (sz * sz - 1);
  return {
    box: [Math.min(...corners.map(p => p[0])), Math.min(...corners.map(p => p[1])), Math.max(...corners.map(p => p[0])), Math.max(...corners.map(p => p[1]))],
    sphere: [width / 2 + focus * tangent(sx, -1), height / 2 - focus * tangent(sy, 1), width / 2 + focus * tangent(sx, 1), height / 2 - focus * tangent(sy, -1)],
  };
}

const luma = (rgb: number[]) => rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
export function inspectThreePixels(data: Uint8Array, channels: 3 | 4, frame: number, predicted: ReturnType<typeof projectThreeBounds>) {
  const box: Bounds = [width, height, -1, -1], sphere: Bounds = [width, height, -1, -1];
  const pixel = (x: number, y: number) => Array.from(data.subarray((y * width + x) * channels, (y * width + x) * channels + 3));
  let boxPixels = 0, spherePixels = 0;
  for (let i = 0, p = 0; i < data.length; i += channels, p++) {
    if (channels === 4 && data[i + 3] !== 255) assert.fail(`Frame ${frame} is not an opaque preview.`);
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const bounds = b > r + 30 && g > r + 25 && b > 50 ? box : r > b + 45 && g > b + 20 && r > 80 ? sphere : undefined;
    if (!bounds) continue;
    const x = p % width, y = Math.floor(p / width);
    bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y); bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y);
    if (bounds === box) boxPixels++; else spherePixels++;
  }
  const tolerance = channels === 4 ? 3 : 5;
  for (const [name, bounds, count] of [["box", box, boxPixels], ["sphere", sphere, spherePixels]] as const) {
    const target = predicted[name];
    assert.ok(bounds.every((value, i) => Math.abs(value - target[i]) <= tolerance), `Frame ${frame} ${name} bounds ${bounds} differ from projected ${target}`);
    const coverage = count / ((bounds[2] - bounds[0] + 1) * (bounds[3] - bounds[1] + 1));
    assert.ok(coverage >= 0.7 && coverage <= 0.96, `Frame ${frame} ${name} shows an incomplete silhouette`);
  }
  const background = [[8, 8], [630, 8], [8, 350], [630, 350]].map(([x, y]) => pixel(x, y));
  assert.ok(background.every(rgb => rgb.every((c, i) => Math.abs(c - [7, 17, 31][i]) <= (channels === 4 ? 0 : 6))), `Frame ${frame} has the wrong background`);
  const cx = Math.round((predicted.sphere[0] + predicted.sphere[2]) / 2), cy = Math.round((predicted.sphere[1] + predicted.sphere[3]) / 2);
  const bright = pixel(cx - 26, cy - 26), shade = pixel(cx + 26, cy + 26);
  assert.ok(luma(bright) - luma(shade) >= 24, `Frame ${frame} is missing the sphere's directional shading`);
  return { frame, box, sphere, boxPixels, spherePixels, bright, shade };
}
