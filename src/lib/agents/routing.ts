/**
 * Stage → model routing table.
 *
 * Each pipeline stage declares its primary model, a fallback chain, the
 * capabilities a model must have to serve it, its tool allowlist, its round
 * limit, and the deterministic fallback that takes over when every model
 * attempt fails. The table is code-versioned; every Plan snapshots the
 * resolved routing (`snapshotRouting`) so a plan always records which models
 * it ran against.
 */

import {
  MODELS,
  isModelId,
  satisfies,
  type ModelCapabilities,
  type ModelId,
  type ModelSpec,
  type ModelTier,
} from "./models.ts";

export type Stage = "classifier" | "planner" | "editor" | "verifier";

export const STAGES: readonly Stage[] = [
  "classifier",
  "planner",
  "editor",
  "verifier",
];

export type ToolName =
  | "list_files"
  | "read_file"
  | "create_file"
  | "edit_file"
  | "delete_file"
  | "run_command"
  | "create_checkpoint"
  | "submit_plan";

export interface StageRoute {
  stage: Stage;
  /** Chip label shown in the agent panel. */
  label: string;
  model: ModelId;
  /** Tried in order after `model`. */
  fallbacks: readonly ModelId[];
  /** Total model attempts before the deterministic fallback; walks the chain, repeating the last entry if needed. */
  attempts: number;
  reasoning: boolean;
  requires: Partial<ModelCapabilities>;
  tools: readonly ToolName[];
  maxRounds: number;
  /** False when the stage's output is produced by deterministic code (the verifier's checks). */
  usesModel: boolean;
  /** What takes over when every model attempt fails; null means the stage fails. */
  deterministicFallback: string | null;
}

/** Bump when the table changes so plan snapshots stay attributable. */
export const ROUTING_VERSION = 1;

export const ROUND_LIMITS = {
  editor: 6,
  corrective: 5,
  buildMode: 4,
} as const;

const READ_TOOLS = ["list_files", "read_file"] as const satisfies readonly ToolName[];
const WRITE_TOOLS = [
  "create_file",
  "edit_file",
  "delete_file",
  "run_command",
  "create_checkpoint",
] as const satisfies readonly ToolName[];

export const ROUTING: Readonly<Record<Stage, StageRoute>> = {
  classifier: {
    stage: "classifier",
    label: "Classifier",
    model: "glm-4.7-air",
    fallbacks: ["glm-4.7"],
    attempts: 1,
    reasoning: false,
    requires: { jsonMode: true },
    tools: [],
    maxRounds: 1,
    usesModel: true,
    deterministicFallback: "keyword heuristics",
  },
  planner: {
    stage: "planner",
    label: "Planner · Interviewer",
    model: "glm-4.7",
    fallbacks: ["glm-4.6"],
    attempts: 2,
    reasoning: true,
    requires: { reasoning: true, toolUse: true },
    // Sandboxed: read-only, plus the intercepted submit_plan pseudo-tool.
    tools: [...READ_TOOLS, "submit_plan"],
    maxRounds: 1,
    usesModel: true,
    deterministicFallback: "per-type question bank",
  },
  editor: {
    stage: "editor",
    label: "Editor",
    model: "glm-4.7",
    fallbacks: ["glm-4.6"],
    attempts: 2,
    reasoning: false,
    requires: { toolUse: true },
    tools: [...READ_TOOLS, ...WRITE_TOOLS],
    maxRounds: ROUND_LIMITS.editor,
    usesModel: true,
    // Structural failures are handled by the verifier-driven corrective round, not here.
    deterministicFallback: null,
  },
  verifier: {
    stage: "verifier",
    label: "Verifier",
    model: "glm-4.7-air",
    fallbacks: [],
    attempts: 0,
    reasoning: false,
    requires: {},
    tools: ["list_files", "read_file"],
    maxRounds: 1,
    usesModel: false,
    deterministicFallback: "deterministic 5-check gate",
  },
};

export type RoutingOverrides = Partial<Record<Stage, ModelId>>;

export interface ResolveOptions {
  /** Pin a stage to a model (Home model selector, env, admin). Tried before the table's chain. */
  overrides?: RoutingOverrides;
  /** Models currently reachable; defaults to every registered model. */
  available?: ReadonlySet<ModelId>;
}

export interface ResolvedStage {
  route: StageRoute;
  /** Usable models in attempt order, deduplicated; empty means the stage goes straight to its deterministic fallback. */
  chain: ModelSpec[];
}

export type RoutingIssueCode =
  | "OVERRIDE_UNAVAILABLE"
  | "OVERRIDE_MISSING_CAPABILITY"
  | "NO_MODEL_AVAILABLE";

export interface RoutingIssue {
  stage: Stage;
  code: RoutingIssueCode;
  message: string;
}

export interface ResolvedRouting {
  stages: Record<Stage, ResolvedStage>;
  /** Business problems come back as data, never thrown. */
  issues: RoutingIssue[];
}

export function resolveRouting(options: ResolveOptions = {}): ResolvedRouting {
  const available = options.available ?? new Set(Object.keys(MODELS) as ModelId[]);
  const issues: RoutingIssue[] = [];
  const stages = {} as Record<Stage, ResolvedStage>;

  for (const stage of STAGES) {
    const route = ROUTING[stage];
    const override = options.overrides?.[stage];
    const candidates: ModelId[] = [];

    if (override) {
      const spec = MODELS[override];
      if (!available.has(override)) {
        issues.push({
          stage,
          code: "OVERRIDE_UNAVAILABLE",
          message: `${spec.label} is not available; using the default chain.`,
        });
      } else if (!satisfies(spec, route.requires)) {
        issues.push({
          stage,
          code: "OVERRIDE_MISSING_CAPABILITY",
          message: `${spec.label} lacks a capability the ${route.label} stage requires; using the default chain.`,
        });
      } else {
        candidates.push(override);
      }
    }

    candidates.push(route.model, ...route.fallbacks);

    const chain = [...new Set(candidates)]
      .filter((id) => available.has(id) && satisfies(MODELS[id], route.requires))
      .map((id) => MODELS[id]);

    if (route.usesModel && chain.length === 0) {
      issues.push({
        stage,
        code: "NO_MODEL_AVAILABLE",
        message: route.deterministicFallback
          ? `No model can serve ${route.label}; falling back to ${route.deterministicFallback}.`
          : `No model can serve ${route.label}.`,
      });
    }

    stages[stage] = { route, chain };
  }

  return { stages, issues };
}

/** The models a stage will try, in order, honoring `attempts`. */
export function attemptSequence(resolved: ResolvedStage): ModelSpec[] {
  const { chain, route } = resolved;
  if (!route.usesModel || chain.length === 0) return [];
  return Array.from(
    { length: route.attempts },
    (_, i) => chain[Math.min(i, chain.length - 1)]!, // chain is non-empty (checked above)
  );
}

/** JSON-safe snapshot stored on `Plan.routing` for provenance. */
export interface RoutingSnapshot {
  version: number;
  stages: Record<Stage, { model: ModelId | null; chain: ModelId[]; reasoning: boolean }>;
}

export function snapshotRouting(resolved: ResolvedRouting): RoutingSnapshot {
  const stages = {} as RoutingSnapshot["stages"];
  for (const stage of STAGES) {
    const { route, chain } = resolved.stages[stage];
    stages[stage] = {
      model: chain[0]?.id ?? null,
      chain: chain.map((m) => m.id),
      reasoning: route.reasoning,
    };
  }
  return { version: ROUTING_VERSION, stages };
}

/** Row shape of the `agentRouting` GraphQL query (one stage chip each). */
export interface AgentRouteView {
  stage: Stage;
  label: string;
  model: ModelId | null;
  modelLabel: string | null;
  tier: ModelTier | null;
  reasoning: boolean;
  creditsPerAction: number;
  fallbacks: ModelId[];
  usesModel: boolean;
  deterministicFallback: string | null;
}

export function agentRouting(resolved: ResolvedRouting): AgentRouteView[] {
  return STAGES.map((stage) => {
    const { route, chain } = resolved.stages[stage];
    const primary = route.usesModel ? chain[0] : undefined;
    return {
      stage,
      label: route.label,
      model: primary?.id ?? null,
      modelLabel: primary?.label ?? null,
      tier: primary?.tier ?? null,
      reasoning: route.reasoning,
      creditsPerAction: primary?.creditsPerAction ?? 0,
      fallbacks: chain.slice(1).map((m) => m.id),
      usesModel: route.usesModel,
      deterministicFallback: route.deterministicFallback,
    };
  });
}

/** Reads `POLYGENTIC_MODEL_<STAGE>` (e.g. POLYGENTIC_MODEL_EDITOR=glm-4.7-max); unknown ids are ignored. */
export function overridesFromEnv(
  env: Record<string, string | undefined>,
): RoutingOverrides {
  const overrides: RoutingOverrides = {};
  for (const stage of STAGES) {
    const value = env[`POLYGENTIC_MODEL_${stage.toUpperCase()}`]?.trim();
    if (value && isModelId(value)) overrides[stage] = value;
  }
  return overrides;
}
