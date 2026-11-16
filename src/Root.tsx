import { Composition } from "remotion";
import { ScienceMotionDemo } from "./compositions/ScienceMotionDemo";
import { ProjectGraphComposition, type ProjectGraphProps } from "./compositions/ProjectGraphComposition";
import episode from "../episodes/cpu-cache/episode.json";
import projectDemo from "../examples/project-graph-demo.props.json";

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="ScienceMotionDemo" component={ScienceMotionDemo}
      durationInFrames={episode.episode.durationFrames} fps={episode.episode.fps}
      width={episode.episode.outputProfile.width} height={episode.episode.outputProfile.height} />
    <Composition id="ProjectGraph" component={ProjectGraphComposition}
      durationInFrames={projectDemo.project.sequences[0].durationFrames}
      fps={projectDemo.project.sequences[0].fps} width={projectDemo.project.sequences[0].width}
      height={projectDemo.project.sequences[0].height} defaultProps={projectDemo as ProjectGraphProps} />
  </>
);
