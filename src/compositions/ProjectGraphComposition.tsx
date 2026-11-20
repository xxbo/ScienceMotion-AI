import React, { useMemo } from "react";
import { AbsoluteFill, Img, useCurrentFrame } from "remotion";
import type { ProjectDocument } from "../contracts/project";
import { buildProjectRenderModel, type ProjectRenderModel } from "../renderers/remotion/project-render-model";
import { ProjectChartSvg } from "./ProjectChartSvg";
import { ProjectLayoutProbe } from "./ProjectLayoutProbe";

export interface ProjectGraphProps {
  project: ProjectDocument;
  sceneId?: string;
  imageSources?: Readonly<Record<string, string>>;
  layoutInspection?: { token: string };
}
export const ProjectGraphComposition: React.FC<ProjectGraphProps> = ({ project, sceneId, imageSources, layoutInspection }) => {
  const frame = useCurrentFrame();
  const model = useMemo(() => buildProjectRenderModel(project, frame, sceneId), [project, frame, sceneId]);
  return <><ProjectGraphFrame model={model} imageSources={imageSources} />{layoutInspection &&
    <ProjectLayoutProbe key={frame} model={model} frame={frame} token={layoutInspection.token} />}</>;
};

/** The same frame surface is used by Remotion and markup regression checks. */
export const ProjectGraphFrame: React.FC<{ model: ProjectRenderModel; imageSources?: Readonly<Record<string, string>> }> = ({ model, imageSources }) => {
  const backgroundColor = "#07111f", crossfade = model.crossfade;
  return (
    <AbsoluteFill data-project-graph-root="true" style={{ backgroundColor, color: "#f4f7fb", overflow: "hidden" }}>
      {crossfade ? (
        <>
          <AbsoluteFill data-project-transition-outgoing="true" aria-hidden="true">
            <ProjectSceneElements elements={crossfade.outgoingElements} imageSources={imageSources} />
          </AbsoluteFill>
          <AbsoluteFill style={{ backgroundColor, opacity: crossfade.incomingOpacity }}>
            <ProjectSceneElements elements={model.elements} imageSources={imageSources} />
          </AbsoluteFill>
        </>
      ) : <ProjectSceneElements elements={model.elements} imageSources={imageSources} />}
      {model.videoClips.map(clip => (
        <Img key={clip.clipId} data-clip-id={clip.clipId} src={imageSources?.[clip.artifactId] ?? ""} alt=""
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "fill" }} />
      ))}
    </AbsoluteFill>
  );
};

const ProjectSceneElements: React.FC<{ elements: ProjectRenderModel["elements"]; imageSources?: Readonly<Record<string, string>> }> =
  ({ elements, imageSources }) => (
    <>
      {elements.map((element) => element.type === "chart" ? (
        <ProjectChartSvg key={element.id} element={element} />
      ) : element.type === "path" ? (
        <svg key={element.id} data-node-id={element.id} viewBox={"0 0 " + element.width + " " + element.height} style={{ position: "absolute", left: 0, top: 0, width: element.width, height: element.height, overflow: "visible", transform: element.transform, transformOrigin: "0 0", opacity: element.opacity }}>
          <path d={element.pathData} fill={element.fill} fillRule={element.fillRule} stroke={element.stroke === "transparent" ? "none" : element.stroke} strokeWidth={element.strokeWidth} />
        </svg>
      ) : element.type === "image" ? (
        <div key={element.id} data-node-id={element.id} style={{
          position: "absolute", left: 0, top: 0, width: element.width, height: element.height,
          transform: element.transform, transformOrigin: "0 0", opacity: element.opacity,
        }}>
          <Img src={imageSources?.[element.imageArtifactId!] ?? ""} alt="" style={{ display: "block", width: "100%", height: "100%", objectFit: "fill" }} />
        </div>
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
    </>
  );
