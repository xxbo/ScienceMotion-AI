import React, { useEffect, useState } from "react";
import { Artifact, cancelRender, continueRender, delayRender } from "remotion";
import type { LayoutFrameMeasurement } from "../contracts/layout-inspection";
import type { ProjectRenderModel } from "../renderers/remotion/project-render-model";
import { measureProjectLayout } from "../renderers/remotion/measure-project-layout";

/** Nonvisual instrumentation; the rendered surface and its styles are unchanged. */
export const ProjectLayoutProbe: React.FC<{ model: ProjectRenderModel; frame: number; token: string }> = ({ model, frame, token }) => {
  const [handle] = useState(() => delayRender("Measure production layout after fonts load", { timeoutInMilliseconds: 15000 }));
  const [measurement, setMeasurement] = useState<LayoutFrameMeasurement>();
  useEffect(() => {
    let active = true;
    const measure = async () => {
      await document.fonts.ready;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (active) setMeasurement(measureProjectLayout(model, frame));
    };
    void measure().catch((error) => { if (active) cancelRender(error); });
    return () => { active = false; continueRender(handle); };
  }, [model, frame, handle]);
  // Artifact registers in a layout effect, before this passive effect releases the render.
  useEffect(() => { if (measurement) continueRender(handle); }, [measurement, handle]);
  return measurement ? <Artifact filename={`layout-${token}-${frame}.json`} content={JSON.stringify(measurement)} /> : null;
};
