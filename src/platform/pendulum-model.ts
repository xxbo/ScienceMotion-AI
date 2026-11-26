import Ajv from "ajv";
import schema from "../../schemas/pendulum-model.schema.json";
import type { PendulumModel, PendulumState } from "../contracts/pendulum-model";
import type { Vector3 } from "../contracts/project";

const validate = new Ajv({ strict: true, ownProperties: true }).compile<PendulumModel>(schema);
const pointerToken = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");

export class PendulumModelError extends Error {
  readonly code = "PENDULUM_MODEL_INVALID";
  constructor(readonly path: string, message: string) {
    super(`${path || "/"} ${message}`);
    this.name = "PendulumModelError";
  }
}

/** Accept only the explicit model version and units, without conversion, rounding or defaults. */
export function parsePendulumModel(input: unknown): PendulumModel {
  if (!validate(input)) {
    const error = validate.errors![0];
    const property = error.keyword === "required" ? error.params.missingProperty :
      error.keyword === "additionalProperties" ? error.params.additionalProperty : undefined;
    const path = error.instancePath + (typeof property === "string" ? "/" + pointerToken(property) : "");
    throw new PendulumModelError(path, error.message ?? "does not match the pendulum model contract");
  }
  const { lengthMeters: length, gravityMetersPerSecondSquared: gravity } = input;
  const rateSquared = gravity / length, energyScale = (gravity * length) * 2;
  if (!Number.isFinite(rateSquared) || rateSquared === 0 || !Number.isFinite(energyScale) || energyScale === 0)
    throw new PendulumModelError("/gravityMetersPerSecondSquared", "must give finite positive g/L and 2gL together with lengthMeters");
  return structuredClone(input);
}

type Parameters = Pick<PendulumModel, "lengthMeters" | "gravityMetersPerSecondSquared">;

/** Instantaneous derivative of angular velocity in rad/s². The derivative of theta is omega. */
export function pendulumAngularAcceleration(model: Parameters, angleRadians: number): number {
  return -(model.gravityMetersPerSecondSquared / model.lengthMeters) * Math.sin(angleRadians);
}

/** Point-mass position in metres in the XY swing plane. */
export function pendulumBobPosition(model: Pick<Parameters, "lengthMeters">, angleRadians: number): Vector3 {
  const length = model.lengthMeters;
  return [length * Math.sin(angleRadians), -length * Math.cos(angleRadians), 0];
}

/** Mechanical energy per kilogram, with zero potential at the lowest point. */
export function pendulumSpecificEnergy(model: Parameters, state: PendulumState): number {
  const speed = model.lengthMeters * state.angularVelocityRadiansPerSecond;
  const halfAngleSine = Math.sin(state.angleRadians / 2);
  return (0.5 * speed) * speed + 2 * (model.gravityMetersPerSecondSquared * model.lengthMeters) * halfAngleSine ** 2;
}
