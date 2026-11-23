import type { ValidateFunction } from "ajv";
import decisionSchema from "../../schemas/creative-planner-decision.schema.json";
import type { ToolSearchQuery } from "../contracts/agent-tool";
import type { CreativeSession } from "../contracts/creative-host";
import { CREATIVE_PLANNER_PROTOCOL, type CreativePlanner, type CreativePlannerDecision, type CreativePlannerObservation } from "../contracts/creative-planner";
import { assertFiniteJson } from "./project-creative-edits";
import { createToolSchemaValidator, formatToolSchemaErrors } from "./tool-schema-validation";

const MAX_DECISION_BYTES = 1024 * 1024;
const validateDecision = createToolSchemaValidator().compile<CreativePlannerDecision>(decisionSchema);

export class CreativePlanningError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CreativePlanningError";
  }
}

function parseDecision(text: string): CreativePlannerDecision {
  if (typeof text !== "string") throw new CreativePlanningError("PLANNER_DECISION_INVALID", "Planner must return JSON text");
  if (Buffer.byteLength(text) > MAX_DECISION_BYTES)
    throw new CreativePlanningError("PLANNER_DECISION_TOO_LARGE", "Planner decision exceeds the 1 MiB limit");
  let value: unknown;
  try {
    value = JSON.parse(text);
    assertFiniteJson(value);
  } catch {
    throw new CreativePlanningError("PLANNER_DECISION_INVALID", "Planner decision must be finite JSON");
  }
  if (!validateDecision(value))
    throw new CreativePlanningError("PLANNER_DECISION_INVALID", formatToolSchemaErrors(validateDecision));
  return value;
}

/** Request and validate one proposal using the catalogue visible to a project-bound session. */
export async function planCreativeStep(
  session: Pick<CreativeSession, "projectId" | "discover" | "manifest">,
  planner: CreativePlanner,
  { brief, query, signal, observation }: { brief: string; query?: ToolSearchQuery; signal?: AbortSignal; observation?: CreativePlannerObservation },
): Promise<CreativePlannerDecision> {
  signal?.throwIfAborted();
  if (typeof brief !== "string" || !brief.trim())
    throw new CreativePlanningError("PLANNER_BRIEF_INVALID", "Supply an approved creative brief");
  const catalogue = await session.discover(query);
  signal?.throwIfAborted();
  const raw = await planner.propose({ protocolVersion: CREATIVE_PLANNER_PROTOCOL, projectId: session.projectId,
    brief, catalogue: structuredClone(catalogue), ...(observation ? { observation: structuredClone(observation) } : {}) }, signal);
  signal?.throwIfAborted();
  const decision = parseDecision(raw);
  if (decision.kind !== "invoke") return decision;

  const offered = catalogue.tools.find(tool => tool.id === decision.toolId);
  if (!offered) throw new CreativePlanningError("PLANNER_TOOL_NOT_DISCOVERED", "Select a tool from the supplied discovery page");
  if (offered.version !== decision.toolVersion)
    throw new CreativePlanningError("PLANNER_TOOL_VERSION_MISMATCH", "Use the exact discovered tool version");
  const current = await session.manifest(decision.toolId);
  signal?.throwIfAborted();
  if (!current || current.version !== offered.version)
    throw new CreativePlanningError("PLANNER_TOOL_CHANGED", "Tool availability or version changed during planning");

  let validateInput: ValidateFunction;
  try { validateInput = createToolSchemaValidator().compile(current.inputSchema); }
  catch { throw new CreativePlanningError("PLANNER_TOOL_SCHEMA_INVALID", "The selected input schema could not be compiled"); }
  try {
    const matches = validateInput(decision.input);
    if (matches === false) throw new Error(formatToolSchemaErrors(validateInput));
    // Ajv also supports asynchronous schemas, which reject on validation failure.
    await matches;
  } catch (error) {
    throw new CreativePlanningError("PLANNER_TOOL_INPUT_INVALID", error instanceof Error ? error.message : "Input validation failed");
  }
  signal?.throwIfAborted();
  return decision;
}
