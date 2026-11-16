import React from "react";
import type { ProjectRenderElement } from "../renderers/remotion/project-render-model";

const formatValue = (value: number): string => {
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  return magnitude >= 10000 || magnitude < 0.01
    ? value.toExponential(1).replace("e+", "e")
    : String(Math.round(value * 100) / 100);
};
const shortLabel = (label: string, length: number): string => {
  const characters = Array.from(label);
  return characters.length <= length ? label : characters.slice(0, Math.max(1, length - 1)).join("") + "…";
};

/** Data-only charts share the Project Graph's transform, opacity and drawing order. */
export const ProjectChartSvg: React.FC<{ element: ProjectRenderElement }> = ({ element }) => {
  const data = element.chartData;
  if (!data?.length || (element.chartType !== "bar" && element.chartType !== "line")) return null;
  const { width, height } = element;
  const fontSize = Math.max(8, Math.min(element.fontSize, 48, width / 12, height / 8));
  const left = Math.min(width * 0.28, Math.max(56, fontSize * 4.5));
  const right = Math.max(left + 1, width - Math.max(12, fontSize));
  const top = fontSize + 16;
  const bottom = Math.max(top + 1, height - (fontSize * 3 + 16));
  const plotWidth = right - left, plotHeight = bottom - top;
  const slot = plotWidth / data.length;

  // Normalize first: max - min would overflow for valid mixed-sign values near MAX_VALUE.
  const magnitude = Math.max(...data.map((point) => Math.abs(point.value))) || 1;
  const normalized = data.map((point) => point.value / magnitude);
  const min = Math.min(0, ...normalized);
  const max = Math.max(0, ...normalized) || (min === 0 ? 1 : 0);
  const projectY = (value: number) => bottom - (value - min) / (max - min) * plotHeight;
  const zeroY = projectY(0);
  const points = data.map((point, index) => ({ ...point,
    x: left + slot * (index + 0.5), y: projectY(normalized[index]) }));
  const tickCount = Math.max(1, Math.min(4, Math.floor(plotHeight / (fontSize * 1.8))));
  const ticks = Array.from({ length: tickCount + 1 }, (_, index) => min + (max - min) * index / tickCount);
  const labelStride = Math.max(1, Math.ceil(fontSize * 3 / slot));
  const labelLength = Math.max(1, Math.floor(slot * labelStride / (fontSize * 0.7)));
  const barWidth = slot * 0.62;

  return (
    <svg data-node-id={element.id} data-chart-type={element.chartType} role="img"
      aria-label={`${element.chartType} chart: ${data.map((p) => `${p.label}: ${p.value}`).join(", ")}`}
      viewBox={`0 0 ${width} ${height}`}
      style={{ position: "absolute", left: 0, top: 0, width, height, overflow: "hidden",
        transform: element.transform, transformOrigin: "0 0", opacity: element.opacity,
        fontFamily: element.fontFamily, fontSize, fontWeight: element.fontWeight }}>
      {ticks.map((tick, index) => (
        <g key={index}>
          <line x1={left} y1={projectY(tick)} x2={right} y2={projectY(tick)}
            stroke={element.stroke} strokeOpacity={0.22} strokeWidth={1} />
          <text x={left - 8} y={projectY(tick)} dy="0.35em" textAnchor="end" fill={element.color}>
            {formatValue(tick * magnitude)}
          </text>
        </g>
      ))}
      <line x1={left} y1={top} x2={left} y2={bottom} stroke={element.stroke} strokeWidth={1} />
      <line data-chart-zero-axis="true" x1={left} y1={zeroY} x2={right} y2={zeroY}
        stroke={element.stroke} strokeWidth={1.5} />
      {element.chartType === "line" && (
        <polyline data-chart-series="true" points={points.map((p) => `${p.x},${p.y}`).join(" ")}
          fill="none" stroke={element.fill} strokeWidth={Math.max(2, element.strokeWidth)}
          strokeLinejoin="round" strokeLinecap="round" />
      )}
      {points.map((point, index) => (
        <g key={index}>
          <title>{`${point.label}: ${point.value}`}</title>
          {element.chartType === "bar" ? (
            <rect data-chart-bar={index} x={point.x - barWidth / 2} y={Math.min(point.y, zeroY)}
              width={barWidth} height={Math.abs(point.y - zeroY)} fill={element.fill} />
          ) : (
            <circle data-chart-point={index} cx={point.x} cy={point.y}
              r={Math.max(2, Math.min(5, slot / 5))} fill={element.fill} />
          )}
          {index % labelStride === 0 && (
            <>
              <text data-chart-value={index} x={point.x} y={point.y + (point.value < 0 ? fontSize + 6 : -8)}
                textAnchor="middle" fill={element.color}>{formatValue(point.value)}</text>
              <text data-chart-category={index} x={point.x} y={height - 8}
                textAnchor="middle" fill={element.color}>{shortLabel(point.label, labelLength)}</text>
            </>
          )}
        </g>
      ))}
    </svg>
  );
};
