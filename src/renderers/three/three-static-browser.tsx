import React, { useLayoutEffect, useRef, useState } from "react";
import { cancelRender, Composition, continueRender, delayRender, registerRoot, useCurrentFrame } from "remotion";
import {
  AmbientLight, BoxGeometry, Color, DirectionalLight, Mesh, MeshLambertMaterial, NoToneMapping, PerspectiveCamera,
  Scene, SphereGeometry, SRGBColorSpace, WebGLRenderer, type BufferGeometry,
} from "three";
import type { ThreeCameraPose, ThreeStaticScene } from "./three-static-scene";
import { ThreePendulumReplayFrame } from "./three-pendulum-browser";

type Props = { model: ThreeStaticScene | null; cameraFrames?: ThreeCameraPose[] };

function createPainter(canvas: HTMLCanvasElement, model: ThreeStaticScene) {
  const { width, height } = model.profile;
  const context = canvas.getContext("webgl2", { alpha: false, antialias: true, preserveDrawingBuffer: true });
  if (!context) throw new Error("THREE_STATIC_WEBGL_UNAVAILABLE: The browser could not initialize WebGL2.");
  const scene = new Scene();
  const geometries: BufferGeometry[] = [];
  const materials: MeshLambertMaterial[] = [];
  let renderer: WebGLRenderer | undefined;
  const dispose = () => {
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    renderer?.dispose();
  };
  try {
    const viewport = context.getParameter(context.MAX_VIEWPORT_DIMS) as Int32Array;
    const framebuffer = context.getParameter(context.MAX_RENDERBUFFER_SIZE) as number;
    if (width > Math.min(viewport[0], framebuffer) || height > Math.min(viewport[1], framebuffer))
      throw new Error("THREE_STATIC_WEBGL_LIMIT: The profile exceeds the browser's WebGL2 viewport or framebuffer size.");
    renderer = new WebGLRenderer({ canvas, context });
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = NoToneMapping;
    scene.background = new Color(model.backgroundColor);

    const view = model.camera;
    const camera = new PerspectiveCamera(view.fovYDegrees, width / height, view.near, view.far);

    for (const item of model.meshes) {
      const shape = item.geometry;
      const geometry = shape.primitive === "box" ? new BoxGeometry(shape.width, shape.height, shape.depth) : new SphereGeometry(shape.radius, 32, 24);
      const material = new MeshLambertMaterial({ color: new Color(item.material.color) });
      geometries.push(geometry);
      materials.push(material);
      const mesh = new Mesh(geometry, material);
      mesh.position.set(...item.transform.position);
      mesh.rotation.set(...item.transform.rotationRadians, "XYZ");
      mesh.scale.set(...item.transform.scale);
      scene.add(mesh);
    }
    for (const item of model.lights) {
      const color = new Color(item.color);
      if (item.type === "ambient") scene.add(new AmbientLight(color, item.intensity));
      else {
        const light = new DirectionalLight(color, item.intensity);
        light.position.set(...item.position);
        light.target.position.set(...item.target);
        scene.add(light, light.target);
      }
    }
    const activeRenderer = renderer;
    const paint = (pose: ThreeCameraPose) => {
      camera.position.set(...pose.position);
      camera.rotation.set(...pose.rotationRadians, "XYZ");
      activeRenderer.render(scene, camera);
      if (context.isContextLost() || context.getError() !== context.NO_ERROR) throw new Error("The WebGL2 render did not complete.");
    };
    return { paint, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

const ThreeFrame: React.FC<Props> = ({ model, cameraFrames }) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const painter = useRef<ReturnType<typeof createPainter> | null>(null);
  const waiting = useRef(true);
  const frame = useCurrentFrame();
  const [handle] = useState(() => delayRender("Paint the Three.js scene"));
  useLayoutEffect(() => {
    try {
      if (!canvas.current || !model) throw new Error("Missing prepared Three.js scene.");
      const current = createPainter(canvas.current, model);
      painter.current = current;
      return () => { painter.current = null; current.dispose(); };
    } catch (error) {
      cancelRender(error instanceof Error ? error : new Error(String(error)));
    }
  }, [model]);
  useLayoutEffect(() => {
    if (!painter.current || !model) return;
    try {
      const pose = cameraFrames ? cameraFrames[frame] : model.camera;
      if (!pose) throw new Error(`Missing camera pose for output frame ${frame}.`);
      painter.current.paint(pose);
      if (waiting.current) { waiting.current = false; continueRender(handle); }
    } catch (error) {
      cancelRender(error instanceof Error ? error : new Error(String(error)));
    }
  }, [model, cameraFrames, frame, handle]);
  return <canvas ref={canvas} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }} />;
};

function ThreeRoot() {
  return <>
    <Composition id="ThreeStaticSnapshot" component={ThreeFrame} width={640} height={360} fps={24} durationInFrames={1}
      defaultProps={{ model: null } as Props} calculateMetadata={({ props }) =>
        ({ ...props.model?.profile, durationInFrames: props.cameraFrames?.length ?? 1 })} />
    <Composition id="ThreePendulumReplay" component={ThreePendulumReplayFrame} width={640} height={360} fps={25} durationInFrames={1}
      defaultProps={{ replay: null }} calculateMetadata={({ props }) =>
        ({ ...props.replay?.profile, durationInFrames: props.replay?.poses.length ?? 1 })} />
  </>;
}

registerRoot(ThreeRoot);
