import { useCurrentFrame } from "remotion";
import type { PendulumReplay } from "../contracts/pendulum-replay";
import { normalizedReplayBob, pendulumReplayStyle as style, pendulumReplayViewport } from "../renderers/shared/pendulum-replay-view";

export const PendulumReplay2D: React.FC<{ replay: PendulumReplay | null }> = ({ replay }) => {
  const frame = useCurrentFrame();
  if (!replay) return null;
  const pose = replay.poses[frame];
  if (!pose) throw new Error("Missing verified pendulum pose for output frame");
  const { width, height } = replay.profile, { pivotX, pivotY, pixelsPerRod: scale } = pendulumReplayViewport(replay.profile);
  const [x, y] = normalizedReplayBob(pose, replay.lengthMeters);
  const bobX = pivotX + scale * x, bobY = pivotY - scale * y;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block", background: style.background }}>
      <circle cx={pivotX} cy={pivotY} r={scale} fill="none" stroke={style.guide} strokeWidth={1} />
      <line x1={pivotX} y1={pivotY} x2={pivotX} y2={pivotY + scale} stroke={style.guide} strokeDasharray="4 5" />
      <line x1={pivotX} y1={pivotY} x2={bobX} y2={bobY} stroke={style.rod} strokeWidth={2 * scale * style.rodRadius} />
      <circle cx={pivotX} cy={pivotY} r={scale * style.pivotRadius} fill={style.pivot} />
      <circle cx={bobX} cy={bobY} r={scale * style.bobRadius} fill={style.bob} />
    </svg>
  );
};
