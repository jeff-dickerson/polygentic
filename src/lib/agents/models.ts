/**
 * Model registry — the single source of truth for every model the platform
 * can route to. Feeds the Home model selector (`availableModels` query) and
 * the stage chips in Plan Mode (model + tier + credits).
 *
 * Context windows and credit costs are configuration, not facts about the
 * provider: confirm them against current provider limits/pricing before
 * relying on them for billing.
 */

export type ModelId = "glm-4.7" | "glm-4.7-air" | "glm-4.6" | "glm-4.7-max";

/** Coarse cost/latency class shown on stage chips. */
export type ModelTier = "air" | "standard" | "max";

export interface ModelCapabilities {
  /** Supports a streamed thinking/reasoning channel. */
  reasoning: boolean;
  /** Reliable at emitting the `<<<TOOL {json} TOOL>>>` block protocol. */
  toolUse: boolean;
  /** Reliable at replying with exactly one JSON object. */
  jsonMode: boolean;
}

export interface ModelSpec {
  id: ModelId;
  label: string;
  tier: ModelTier;
  contextWindow: number;
  creditsPerAction: number;
  capabilities: ModelCapabilities;
  /** Selectable in the Home model selector. */
  selectable: boolean;
}

export const MODELS: Readonly<Record<ModelId, ModelSpec>> = {
  "glm-4.7": {
    id: "glm-4.7",
    label: "GLM-4.7",
    tier: "standard",
    contextWindow: 200_000,
    creditsPerAction: 2,
    capabilities: { reasoning: true, toolUse: true, jsonMode: true },
    selectable: true,
  },
  "glm-4.7-air": {
    id: "glm-4.7-air",
    label: "GLM-4.7 Air",
    tier: "air",
    contextWindow: 128_000,
    creditsPerAction: 1,
    capabilities: { reasoning: false, toolUse: true, jsonMode: true },
    selectable: true,
  },
  "glm-4.6": {
    id: "glm-4.6",
    label: "GLM-4.6",
    tier: "standard",
    contextWindow: 200_000,
    creditsPerAction: 2,
    capabilities: { reasoning: true, toolUse: true, jsonMode: true },
    selectable: true,
  },
  "glm-4.7-max": {
    id: "glm-4.7-max",
    label: "GLM-4.7 Max",
    tier: "max",
    contextWindow: 200_000,
    creditsPerAction: 6,
    capabilities: { reasoning: true, toolUse: true, jsonMode: true },
    selectable: true,
  },
};

export const MODEL_IDS = Object.keys(MODELS) as ModelId[];

export function isModelId(value: string): value is ModelId {
  return Object.hasOwn(MODELS, value);
}

export function getModel(id: ModelId): ModelSpec {
  return MODELS[id];
}

/** Models offered in the Home model selector, cheapest first. */
export function availableModels(): ModelSpec[] {
  return MODEL_IDS.map((id) => MODELS[id])
    .filter((m) => m.selectable)
    .sort((a, b) => a.creditsPerAction - b.creditsPerAction);
}

/** True when `model` has every capability set in `required`. */
export function satisfies(
  model: ModelSpec,
  required: Partial<ModelCapabilities>,
): boolean {
  return (Object.keys(required) as (keyof ModelCapabilities)[]).every(
    (cap) => !required[cap] || model.capabilities[cap],
  );
}
