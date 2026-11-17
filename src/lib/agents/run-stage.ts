/**
 * Runs one pipeline stage against its resolved model chain.
 *
 * Each attempt calls the model, then parses/validates the reply. A thrown
 * call or a rejected parse moves to the next attempt, with the failure fed
 * back so the model can correct itself. When every attempt fails, the
 * stage's deterministic fallback runs, so a model failure degrades the plan
 * and never the session. The SSE layer maps `retry` / `fallback` events to
 * `<stage>_retry` / `<stage>_fallback` (e.g. `planner_retry`).
 */

import type { ModelId, ModelTier } from "./models.ts";
import { attemptSequence, type ResolvedStage, type Stage } from "./routing.ts";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  model: ModelId;
  system: string;
  messages: ChatMessage[];
  reasoning: boolean;
  signal?: AbortSignal;
}

export interface ModelResponse {
  text: string;
  reasoning?: string;
}

/** Provider adapter. One implementation per inference backend. */
export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export type StageEvent =
  | { type: "stage"; stage: Stage; model: ModelId; tier: ModelTier; credits: number; attempt: number }
  | { type: "retry"; stage: Stage; failedModel: ModelId; nextModel: ModelId; error: string }
  | { type: "fallback"; stage: Stage; reason: string; fallback: string };

export interface AttemptContext {
  model: ModelId;
  /** 1-based. */
  attempt: number;
  /** The previous attempt's failure, to feed back into the prompt. */
  previousError?: string;
}

export interface RunStageOptions<T> {
  resolved: ResolvedStage;
  client: ModelClient;
  buildRequest: (ctx: AttemptContext) => Omit<ModelRequest, "model" | "reasoning">;
  /** Validate/parse the reply; throw to reject it and trigger the next attempt. */
  parse: (response: ModelResponse) => T;
  /** Required when the route declares a deterministic fallback. */
  deterministic?: () => T | Promise<T>;
  onEvent?: (event: StageEvent) => void;
}

export interface StageResult<T> {
  value: T;
  /** The model that produced `value`, or "deterministic". */
  source: ModelId | "deterministic";
  attempts: number;
}

export class StageFailedError extends Error {
  readonly stage: Stage;
  readonly errors: string[];

  constructor(stage: Stage, errors: string[]) {
    super(`${stage} failed after ${errors.length} attempt(s): ${errors.at(-1) ?? "no model available"}`);
    this.name = "StageFailedError";
    this.stage = stage;
    this.errors = errors;
  }
}

export async function runStage<T>(options: RunStageOptions<T>): Promise<StageResult<T>> {
  const { resolved, client, buildRequest, parse, deterministic, onEvent } = options;
  const { route } = resolved;
  const sequence = attemptSequence(resolved);
  const errors: string[] = [];

  for (const [i, model] of sequence.entries()) {
    const attempt = i + 1;
    onEvent?.({
      type: "stage",
      stage: route.stage,
      model: model.id,
      tier: model.tier,
      credits: model.creditsPerAction,
      attempt,
    });

    try {
      const request = buildRequest({ model: model.id, attempt, previousError: errors.at(-1) });
      const response = await client.complete({
        ...request,
        model: model.id,
        reasoning: route.reasoning && model.capabilities.reasoning,
      });
      return { value: parse(response), source: model.id, attempts: attempt };
    } catch (err) {
      if (isAbort(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      errors.push(message);
      const next = sequence[i + 1];
      if (next) {
        onEvent?.({
          type: "retry",
          stage: route.stage,
          failedModel: model.id,
          nextModel: next.id,
          error: message,
        });
      }
    }
  }

  if (route.deterministicFallback && deterministic) {
    onEvent?.({
      type: "fallback",
      stage: route.stage,
      reason: errors.at(-1) ?? "no model available",
      fallback: route.deterministicFallback,
    });
    return { value: await deterministic(), source: "deterministic", attempts: sequence.length };
  }

  throw new StageFailedError(route.stage, errors);
}

/** Cancellation (discard / client disconnect) is not a model failure: never retried. */
function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
