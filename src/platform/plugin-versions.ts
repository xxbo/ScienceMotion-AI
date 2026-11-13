/** Bounded stable-version grammar. Unsupported range syntax fails closed. */
export const PLUGIN_VERSION_PATTERN = "(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)";
const versionPattern = new RegExp(`^${PLUGIN_VERSION_PATTERN}$`);

export function isPluginVersion(value: string): boolean {
  return typeof value === "string" && versionPattern.test(value) &&
    value.split(".").every((part) => Number.isSafeInteger(Number(part)));
}

export function isPluginVersionRange(value: string): boolean {
  return value === "*" || isPluginVersion(value) ||
    (typeof value === "string" && /^[~^]/.test(value) && isPluginVersion(value.slice(1)));
}

export function comparePluginVersions(a: string, b: string): number {
  if (!isPluginVersion(a) || !isPluginVersion(b)) throw new Error("Invalid stable plugin version");
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}

export function satisfiesPluginVersion(version: string, range = "*"): boolean {
  if (!isPluginVersion(version) || !isPluginVersionRange(range)) return false;
  if (range === "*") return true;
  if (isPluginVersion(range)) return version === range;
  const base = range.slice(1);
  if (comparePluginVersions(version, base) < 0) return false;
  const [major, minor, patch] = base.split(".").map(Number);
  const [vMajor, vMinor, vPatch] = version.split(".").map(Number);
  if (range[0] === "~") return vMajor === major && vMinor === minor;
  // Caret keeps the leftmost non-zero component fixed (including ^0.x.y).
  if (major > 0) return vMajor === major;
  if (minor > 0) return vMajor === 0 && vMinor === minor;
  return vMajor === 0 && vMinor === 0 && vPatch === patch;
}
