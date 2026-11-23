import Ajv, { type ValidateFunction } from "ajv";

export function createToolSchemaValidator() {
  return new Ajv({ allErrors: true, strict: false });
}

export function formatToolSchemaErrors(validate: ValidateFunction): string {
  return (validate.errors ?? []).map(error => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ");
}
