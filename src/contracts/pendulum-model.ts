/** Angle in radians, angular velocity in rad/s. Zero is down and positive angles turn toward +X. */
export interface PendulumState {
  angleRadians: number;
  angularVelocityRadiansPerSecond: number;
}

/** Fixed pivot at the origin, uniform gravity along −Y, and a massless rigid rod. */
export interface PendulumModel {
  schemaVersion: "1.0.0";
  model: "ideal-simple-pendulum";
  units: "SI";
  coordinateSystem: "right-handed-y-up";
  lengthMeters: number;
  gravityMetersPerSecondSquared: number;
  initialState: PendulumState & { angularVelocityRadiansPerSecond: 0 };
}
