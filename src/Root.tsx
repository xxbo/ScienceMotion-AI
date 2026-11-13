import { Composition } from "remotion";
import { ScienceMotionDemo } from "./compositions/ScienceMotionDemo";
import episode from "../episodes/cpu-cache/episode.json";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="ScienceMotionDemo"
      component={ScienceMotionDemo}
      durationInFrames={episode.episode.durationFrames}
      fps={episode.episode.fps}
      width={episode.episode.outputProfile.width}
      height={episode.episode.outputProfile.height}
    />
  );
};
