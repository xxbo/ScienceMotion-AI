import { Composition } from "remotion";
import { ScienceMotionDemo } from "./compositions/ScienceMotionDemo";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="ScienceMotionDemo"
      component={ScienceMotionDemo}
      durationInFrames={900}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
