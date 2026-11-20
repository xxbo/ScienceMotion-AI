export interface ChartPoint { label: string; value: number }

export function isChartData(value: unknown): value is ChartPoint[] {
  return Array.isArray(value) && value.length >= 2 && value.length <= 24 && value.every(point =>
    point && typeof point.label === "string" && point.label.trim().length > 0 && point.label.length <= 48 &&
    typeof point.value === "number" && Number.isFinite(point.value));
}

export function isSupportedPaint(value: unknown): value is string {
  return typeof value === "string" &&
    (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) ||
     /^(transparent|black|white|red|green|blue|orange|yellow|purple|gray|grey|cyan)$/i.test(value));
}

export const MAX_PATH_DATA_LENGTH = 20_000;
const argumentCounts: Readonly<Record<string, number | undefined>> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

/** Validate complete SVG path command groups, including implicit repetitions and compact arc flags. */
export function isSafeSvgPathData(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_PATH_DATA_LENGTH) return false;
  const number = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
  const whitespace = /[ \t\r\n\f]*/y;
  let cursor = 0;
  const skipWhitespace = () => {
    whitespace.lastIndex = cursor;
    whitespace.exec(value);
    cursor = whitespace.lastIndex;
  };
  skipWhitespace();
  if (value[cursor] !== "M" && value[cursor] !== "m") return false;
  while (cursor < value.length) {
    const command = value[cursor++].toLowerCase();
    const count = argumentCounts[command];
    if (count === undefined) return false;
    skipWhitespace();
    if (count === 0) continue;
    let repeated = false;
    do {
      for (let argument = 0; argument < count; argument++) {
        if (argument > 0 || repeated) {
          skipWhitespace();
          if (value[cursor] === ",") {
            cursor++;
            skipWhitespace();
          }
        }
        if (command === "a" && (argument === 3 || argument === 4)) {
          const flag = value[cursor++];
          if (flag !== "0" && flag !== "1") return false;
        } else {
          number.lastIndex = cursor;
          const match = number.exec(value);
          if (!match) return false;
          if (!Number.isFinite(Number(match[0]))) return false;
          cursor = number.lastIndex;
        }
      }
      skipWhitespace();
      repeated = true;
    } while (cursor < value.length && argumentCounts[value[cursor].toLowerCase()] === undefined);
  }
  return true;
}
