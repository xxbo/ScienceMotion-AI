import type { PendulumSample } from "../contracts/pendulum-trajectory";

export type PendulumEventKind = "bottom-rightward" | "bottom-leftward" | "turn-right" | "turn-left";
export type TimedPendulumEvent = { kind: PendulumEventKind; timeSeconds: number };
export type PendulumAngleObservation = { timeSeconds: number; angleRadians: number };
export type ObservedPendulumEvent = TimedPendulumEvent & {
  method: "linear-crossing" | "quadratic-turn";
  /** Inclusive indices into the decoded clip, not the source scene. */
  support: [number, number];
};

type Direction = 1 | -1;
const bottomKind = (direction: Direction): PendulumEventKind => direction === 1 ? "bottom-rightward" : "bottom-leftward";
const turnKind = (fromSign: Direction): PendulumEventKind => fromSign === 1 ? "turn-right" : "turn-left";

function zeroCrossings<T extends { timeSeconds: number }>(samples: readonly T[], value: (sample: T) => number) {
  const result: Array<{ beforeIndex: number; timeSeconds: number; direction: Direction }> = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i], before = value(a), after = value(b);
    const direction = before < 0 && after >= 0 ? 1 : before > 0 && after <= 0 ? -1 : 0;
    if (!direction) continue;
    const fraction = -before / (after - before);
    result.push({ beforeIndex: i - 1, direction, timeSeconds: a.timeSeconds + fraction * (b.timeSeconds - a.timeSeconds) });
  }
  return result;
}

/** Continuous reference from the retained angles and angular velocities, before any rendering. */
export function retainedPendulumEvents(samples: readonly PendulumSample[]): TimedPendulumEvent[] {
  return [
    ...zeroCrossings(samples, row => row.angleRadians).map(({ direction, timeSeconds }) => ({ kind: bottomKind(direction), timeSeconds })),
    ...zeroCrossings(samples, row => row.angularVelocityRadiansPerSecond).map(({ direction, timeSeconds }) =>
      ({ kind: turnKind(direction === -1 ? 1 : -1), timeSeconds })),
  ].sort((a, b) => a.timeSeconds - b.timeSeconds);
}

const turnRadius = 5;

/** The 25 fps witness uses a local 11-frame least-squares fit to reduce quantized peak bias. */
function fitTurn(rows: readonly PendulumAngleObservation[], from: number, to: number, sign: Direction, frameSeconds: number): ObservedPendulumEvent {
  let center = from;
  for (let i = from + 1; i <= to; i++)
    if (sign * rows[i].angleRadians > sign * rows[center].angleRadians) center = i;
  const support: [number, number] = [center - turnRadius, center + turnRadius];
  if (support[0] < from || support[1] > to)
    throw new Error("A decoded swing needs an 11-frame neighborhood around its interior turn.");
  let sumY = 0, sumKY = 0, sumK2Y = 0, sumK2 = 0, sumK4 = 0;
  for (let k = -turnRadius; k <= turnRadius; k++) {
    const y = rows[center + k].angleRadians;
    sumY += y;
    sumKY += k * y;
    sumK2Y += k * k * y;
    sumK2 += k * k;
    sumK4 += k ** 4;
  }
  // Symmetric k cancels the odd terms in the normal equations for y = a*k*k + b*k + c.
  const meanK2 = sumK2 / (turnRadius * 2 + 1);
  const a = (sumK2Y - meanK2 * sumY) / (sumK4 - meanK2 * sumK2), b = sumKY / sumK2;
  const vertex = -b / (2 * a);
  if (!(sign * a < 0) || !Number.isFinite(vertex) || Math.abs(vertex) > turnRadius)
    throw new Error("The decoded turn has no plausible interior vertex.");
  return { kind: turnKind(sign), timeSeconds: rows[center].timeSeconds + vertex * frameSeconds, method: "quadratic-turn", support };
}

/** Detect crossings and interior turns using only the decoded observation sequence. */
export function detectPendulumEvents(rows: readonly PendulumAngleObservation[], frameSeconds: number): ObservedPendulumEvent[] {
  if (!(frameSeconds > 0) || !Number.isFinite(frameSeconds) || rows.length < 2 ||
      rows.some((row, i) => !Number.isFinite(row.timeSeconds) || !Number.isFinite(row.angleRadians) ||
        (i > 0 && Math.abs(row.timeSeconds - rows[i - 1].timeSeconds - frameSeconds) > 1e-9)))
    throw new Error("Decoded pendulum observations must have a uniform, finite frame clock.");
  const crossings = zeroCrossings(rows, row => row.angleRadians);
  return crossings.flatMap(({ direction, beforeIndex, timeSeconds }, i): ObservedPendulumEvent[] => {
    const crossing: ObservedPendulumEvent = { kind: bottomKind(direction), timeSeconds, method: "linear-crossing",
      support: [beforeIndex, beforeIndex + 1] };
    const next = crossings[i + 1];
    if (!next) return [crossing];
    if (next.direction === direction)
      throw new Error("Decoded bottom crossings do not alternate direction.");
    return [crossing, fitTurn(rows, beforeIndex + 1, next.beforeIndex, direction, frameSeconds)];
  });
}

export function comparePendulumEvents<T extends TimedPendulumEvent>(
  reference: readonly T[], views: Readonly<Record<string, readonly ObservedPendulumEvent[]>>, toleranceSeconds: number,
) {
  const entries = Object.entries(views);
  if (!(toleranceSeconds > 0) || !Number.isFinite(toleranceSeconds) || !reference.length || entries.length < 2)
    throw new Error("Event alignment needs reference events, multiple views and a positive tolerance.");
  if (reference.some((row, i) => !Number.isFinite(row.timeSeconds) || (i > 0 && row.timeSeconds <= reference[i - 1].timeSeconds)))
    throw new Error("Reference events must be finite and strictly ordered.");
  for (const [view, events] of entries) {
    if (events.length !== reference.length || events.some((row, i) => row.kind !== reference[i].kind ||
      !Number.isFinite(row.timeSeconds) || (i > 0 && row.timeSeconds <= events[i - 1].timeSeconds)))
      throw new Error(view + " has a mismatched event count, order or direction.");
  }
  return reference.map((event, i) => {
    const observed = Object.fromEntries(entries.map(([view, events]) => [view,
      { ...events[i], errorSeconds: events[i].timeSeconds - event.timeSeconds }]));
    const times = Object.values(observed).map(row => row.timeSeconds);
    const spreadSeconds = Math.max(...times) - Math.min(...times);
    const maxReferenceErrorSeconds = Math.max(...Object.values(observed).map(row => Math.abs(row.errorSeconds)));
    if (spreadSeconds - toleranceSeconds > 1e-9 || maxReferenceErrorSeconds - toleranceSeconds > 1e-9)
      throw new Error("Event " + event.kind + " at " + event.timeSeconds.toFixed(3) + " s exceeds the timing tolerance.");
    return { reference: event, observed, spreadSeconds, maxReferenceErrorSeconds };
  });
}
