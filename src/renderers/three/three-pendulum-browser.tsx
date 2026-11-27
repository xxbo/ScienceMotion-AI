import { useLayoutEffect, useRef, useState } from "react";
import { cancelRender, continueRender, delayRender, useCurrentFrame } from "remotion";
import {
  AmbientLight, Color, CylinderGeometry, DirectionalLight, DoubleSide, Mesh, MeshBasicMaterial,
  MeshLambertMaterial, NoToneMapping, OrthographicCamera, RingGeometry, Scene, SphereGeometry, SRGBColorSpace, Vector3, WebGLRenderer,
} from "three";
import type { PendulumReplay, PendulumReplayPose } from "../../contracts/pendulum-replay";
import { normalizedReplayBob, pendulumReplayStyle as style, pendulumReplayViewport } from "../shared/pendulum-replay-view";

function createPainter(canvas: HTMLCanvasElement, replay: PendulumReplay) {
  const { width, height } = replay.profile;
  const context = canvas.getContext("webgl2", { alpha: false, antialias: true, preserveDrawingBuffer: true });
  if (!context) throw new Error("THREE_STATIC_WEBGL_UNAVAILABLE: No WebGL2 context.");
  const viewport = context.getParameter(context.MAX_VIEWPORT_DIMS) as Int32Array;
  const framebuffer = context.getParameter(context.MAX_RENDERBUFFER_SIZE) as number;
  if (width > Math.min(viewport[0], framebuffer) || height > Math.min(viewport[1], framebuffer))
    throw new Error("THREE_STATIC_WEBGL_LIMIT: Replay profile exceeds WebGL2 limits.");
  const renderer = new WebGLRenderer({ canvas, context });
  const geometries = [
    new RingGeometry(0.996, 1.004, 96), new CylinderGeometry(style.rodRadius, style.rodRadius, 1, 16),
    new SphereGeometry(style.pivotRadius, 24, 16), new SphereGeometry(style.bobRadius, 32, 24),
  ];
  const materials = [
    new MeshBasicMaterial({ color: style.guide, side: DoubleSide }),
    ...[style.rod, style.pivot, style.bob].map(color => new MeshLambertMaterial({ color })),
  ];
  const dispose = () => {
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
    renderer.dispose();
  };
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = NoToneMapping;
    const scene = new Scene();
    scene.background = new Color(style.background);
    const { pivotY, pixelsPerRod: scale } = pendulumReplayViewport(replay.profile);
    const camera = new OrthographicCamera(-width / (2 * scale), width / (2 * scale), pivotY / scale, (pivotY - height) / scale, 0.1, 12);
    camera.position.z = 4;
    const [guide, rod, pivot, bob] = geometries.map((geometry, i) => new Mesh(geometry, materials[i]));
    guide.position.z = -0.18;
    const light = new DirectionalLight("#ffffff", 2);
    light.position.set(-3, 4, 6);
    scene.add(guide, rod, pivot, bob, new AmbientLight("#ffffff", 1.3), light);
    const up = new Vector3(0, 1, 0), end = new Vector3();
    return {
      dispose,
      paint(pose: PendulumReplayPose) {
        end.set(...normalizedReplayBob(pose, replay.lengthMeters));
        bob.position.copy(end);
        rod.position.copy(end).multiplyScalar(0.5);
        rod.scale.y = end.length();
        rod.quaternion.setFromUnitVectors(up, end.normalize());
        renderer.render(scene, camera);
        if (context.isContextLost() || context.getError() !== context.NO_ERROR)
          throw new Error("The replay's WebGL2 frame did not complete.");
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

export const ThreePendulumReplayFrame: React.FC<{ replay: PendulumReplay | null }> = ({ replay }) => {
  const canvas = useRef<HTMLCanvasElement>(null), painter = useRef<ReturnType<typeof createPainter> | null>(null);
  const waiting = useRef(true), frame = useCurrentFrame();
  const [handle] = useState(() => delayRender("Paint the pendulum replay"));
  useLayoutEffect(() => {
    try {
      if (!canvas.current || !replay) throw new Error("Missing verified replay");
      const current = createPainter(canvas.current, replay);
      painter.current = current;
      return () => { painter.current = null; current.dispose(); };
    } catch (error) { cancelRender(error instanceof Error ? error : new Error(String(error))); }
  }, [replay]);
  useLayoutEffect(() => {
    if (!painter.current || !replay) return;
    try {
      const pose = replay.poses[frame];
      if (!pose) throw new Error("Missing verified pendulum pose for output frame");
      painter.current.paint(pose);
      if (waiting.current) { waiting.current = false; continueRender(handle); }
    } catch (error) { cancelRender(error instanceof Error ? error : new Error(String(error))); }
  }, [replay, frame, handle]);
  return <canvas ref={canvas} style={{ display: "block", width: "100%", height: "100%" }} />;
};
