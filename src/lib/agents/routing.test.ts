import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MODELS, availableModels, type ModelId } from "./models.ts";
import {
  ROUTING,
  STAGES,
  agentRouting,
  attemptSequence,
  overridesFromEnv,
  resolveRouting,
  snapshotRouting,
} from "./routing.ts";

const ids = (models: { id: ModelId }[]) => models.map((m) => m.id);

describe("routing table", () => {
  it("routes every stage to registered models that meet its requirements", () => {
    const { stages, issues } = resolveRouting();
    assert.deepEqual(issues, []);
    for (const stage of STAGES) {
      const { route, chain } = stages[stage];
      assert.equal(chain[0]?.id, route.model);
    }
  });

  it("matches the documented stage → model table", () => {
    assert.equal(ROUTING.classifier.model, "glm-4.7-air");
    assert.equal(ROUTING.planner.model, "glm-4.7");
    assert.equal(ROUTING.planner.reasoning, true);
    assert.equal(ROUTING.editor.model, "glm-4.7");
    assert.equal(ROUTING.verifier.usesModel, false);
  });

  it("keeps the planner sandboxed: no file-writing tools", () => {
    for (const tool of ["create_file", "edit_file", "delete_file", "run_command"] as const) {
      assert.ok(!ROUTING.planner.tools.includes(tool), tool);
    }
    assert.ok(ROUTING.planner.tools.includes("submit_plan"));
    assert.ok(!ROUTING.editor.tools.includes("submit_plan"));
  });
});

describe("resolveRouting", () => {
  it("puts a valid override first and dedupes the chain", () => {
    const { stages } = resolveRouting({ overrides: { editor: "glm-4.7-max" } });
    assert.deepEqual(ids(stages.editor.chain), ["glm-4.7-max", "glm-4.7", "glm-4.6"]);

    const same = resolveRouting({ overrides: { editor: "glm-4.7" } });
    assert.deepEqual(ids(same.stages.editor.chain), ["glm-4.7", "glm-4.6"]);
  });

  it("rejects an override missing a required capability, as data", () => {
    const { stages, issues } = resolveRouting({ overrides: { planner: "glm-4.7-air" } });
    assert.equal(stages.planner.chain[0]?.id, "glm-4.7");
    assert.deepEqual(issues.map((i) => i.code), ["OVERRIDE_MISSING_CAPABILITY"]);
  });

  it("falls through the chain when the primary is unavailable", () => {
    const { stages } = resolveRouting({ available: new Set<ModelId>(["glm-4.6", "glm-4.7-air"]) });
    assert.deepEqual(ids(stages.planner.chain), ["glm-4.6"]);
    assert.deepEqual(ids(stages.classifier.chain), ["glm-4.7-air"]);
  });

  it("reports a stage with no usable model", () => {
    const { stages, issues } = resolveRouting({ available: new Set<ModelId>() });
    assert.deepEqual(stages.planner.chain, []);
    assert.deepEqual(
      issues.map((i) => i.stage),
      ["classifier", "planner", "editor"],
    );
  });
});

describe("attemptSequence", () => {
  it("walks the chain up to the stage's attempt budget", () => {
    const { stages } = resolveRouting();
    assert.deepEqual(ids(attemptSequence(stages.planner)), ["glm-4.7", "glm-4.6"]);
    assert.deepEqual(ids(attemptSequence(stages.classifier)), ["glm-4.7-air"]);
    assert.deepEqual(attemptSequence(stages.verifier), []);
  });

  it("repeats the last model when the chain is shorter than the budget", () => {
    const { stages } = resolveRouting({ available: new Set<ModelId>(["glm-4.7"]) });
    assert.deepEqual(ids(attemptSequence(stages.planner)), ["glm-4.7", "glm-4.7"]);
  });
});

describe("views", () => {
  it("snapshots the resolved routing for Plan.routing", () => {
    const snap = snapshotRouting(resolveRouting());
    assert.equal(snap.stages.planner.model, "glm-4.7");
    assert.deepEqual(snap.stages.planner.chain, ["glm-4.7", "glm-4.6"]);
    assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
  });

  it("exposes stage chips with model, tier and credits", () => {
    const rows = agentRouting(resolveRouting());
    const planner = rows.find((r) => r.stage === "planner");
    assert.equal(planner?.tier, MODELS["glm-4.7"].tier);
    assert.equal(planner?.creditsPerAction, MODELS["glm-4.7"].creditsPerAction);
    const verifier = rows.find((r) => r.stage === "verifier");
    assert.equal(verifier?.model, null);
    assert.equal(verifier?.creditsPerAction, 0);
  });

  it("lists selectable models cheapest first", () => {
    const credits = availableModels().map((m) => m.creditsPerAction);
    assert.deepEqual(credits, [...credits].sort((a, b) => a - b));
  });
});

describe("overridesFromEnv", () => {
  it("reads known model ids and ignores the rest", () => {
    assert.deepEqual(
      overridesFromEnv({
        POLYGENTIC_MODEL_EDITOR: "glm-4.7-max",
        POLYGENTIC_MODEL_PLANNER: "gpt-unknown",
      }),
      { editor: "glm-4.7-max" },
    );
  });
});
