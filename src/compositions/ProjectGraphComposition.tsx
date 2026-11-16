import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import type { ProjectDocument } from "../contracts/project";
import { buildProjectRenderModel, type ProjectRenderModel } from "../renderers/remotion/project-render-model";
import { ProjectChartSvg } from "./ProjectChartSvg";

export interface ProjectGraphProps { project: ProjectDocument; sceneId?: string }
export const ProjectGraphComposition: React.FC<ProjectGraphProps> = ({ project, sceneId }) => {
  const frame = useCurrentFrame();
  const model = buildProjectRenderModel(project, frame, sceneId);
  return <ProjectGraphFrame model={model} />;
};

/** The same frame surface is used by Remotion and markup regression checks. */
export const ProjectGraphFrame: React.FC<{ model: ProjectRenderModel }> = ({ model }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#07111f", color: "#f4f7fb", overflow: "hidden" }}>
      {model.elements.map((element) => element.type === "chart" ? (
        <ProjectChartSvg key={element.id} element={element} />
      ) : element.type === "path" ? (
        <svg key={element.id} data-node-id={element.id} viewBox={"0 0 " + element.width + " " + element.height} style={{ position: "absolute", left: 0, top: 0, width: element.width, height: element.height, overflow: "visible", transform: element.transform, transformOrigin: "0 0", opacity: element.opacity }}>
          <path d={element.pathData} fill={element.fill} fillRule={element.fillRule} stroke={element.stroke === "transparent" ? "none" : element.stroke} strokeWidth={element.strokeWidth} />
        </svg>
      ) : element.type === "text" ? (
        <div key={element.id} data-node-id={element.id} style={{
          position: "absolute", left: 0, top: 0, width: element.width, minHeight: element.height,
          boxSizing: "border-box", transform: element.transform, transformOrigin: "0 0",
          opacity: element.opacity, color: element.color, fontSize: element.fontSize,
          fontFamily: element.fontFamily, fontWeight: element.fontWeight, textAlign: element.textAlign,
          whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.25,
        }}>{element.text}</div>
      ) : (
        <div key={element.id} data-node-id={element.id} style={{
          position: "absolute", left: 0, top: 0, width: element.width, height: element.height,
          boxSizing: "border-box", transform: element.transform, transformOrigin: "0 0",
          opacity: element.opacity, backgroundColor: element.primitive === "line" ? element.stroke : element.fill,
          border: element.strokeWidth > 0 ? element.strokeWidth + "px solid " + element.stroke : "none",
          borderRadius: element.primitive === "circle" || element.primitive === "ellipse" ? "50%" : element.radius,
        }} />
      ))}
    </AbsoluteFill>
  );
};
