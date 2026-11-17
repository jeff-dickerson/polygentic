import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ModelId } from "./models.ts";
import { resolveRouting } from "./routing.ts";
import {
  StageFailedError,
  runStage,
  type ModelClient,
  type ModelRequest,
  type StageEvent,
} from "./run-stage.ts";

/** Replies from a script keyed by call order; an Error entry is thrown. */
function scriptedClient(script: (string | Error)[]) {
  const calls: ModelRequest[] = [];
  const client: ModelClient = {
    async complete(request) {
      calls.push(request);
      const next = script[calls.length - 1];
      if (next === undefined) throw new Error("unexpected call");
      if (next instanceof Error) throw next;
      return { text: next };
    },
  };
  return { client, calls };
}

const parseJson = (r: { text: string }) => JSON.parse(r.text) as { ok: boolean };
const request = () => ({ system: "sys", messages: [{ role: "user" as const, content: "hi" }] });

describe("runStage", () => {
  it("returns the primary model's parsed reply", async () => {
    const { client, calls } = scriptedClient(['{"ok":true}']);
    const events: StageEvent[] = [];
    const result = await runStage({
      resolved: resolveRouting().stages.planner,
      client,
      buildRequest: request,
      parse: parseJson,
      onEvent: (e) => events.push(e),
    });
    assert.deepEqual(result, { value: { ok: true }, source: "glm-4.7", attempts: 1 });
    assert.equal(calls[0]?.reasoning, true);
    assert.deepEqual(events.map((e) => e.type), ["stage"]);
  });

  it("retries on the next model with the failure fed back", async () => {
    const { client, calls } = scriptedClient(["not json", '{"ok":true}']);
    const seen: (string | undefined)[] = [];
    const events: StageEvent[] = [];
    const result = await runStage({
      resolved: resolveRouting().stages.planner,
      client,
      buildRequest: (ctx) => {
        seen.push(ctx.previousError);
        return request();
      },
      parse: parseJson,
      onEvent: (e) => events.push(e),
    });
    assert.equal(result.source, "glm-4.6");
    assert.deepEqual(calls.map((c) => c.model), ["glm-4.7", "glm-4.6"] satisfies ModelId[]);
    assert.equal(seen[0], undefined);
    assert.match(seen[1] ?? "", /JSON/);
    assert.deepEqual(events.map((e) => e.type), ["stage", "retry", "stage"]);
  });

  it("degrades to the deterministic fallback when every attempt fails", async () => {
    const { client } = scriptedClient([new Error("503"), new Error("503")]);
    const events: StageEvent[] = [];
    const result = await runStage({
      resolved: resolveRouting().stages.planner,
      client,
      buildRequest: request,
      parse: parseJson,
      deterministic: () => ({ ok: false }),
      onEvent: (e) => events.push(e),
    });
    assert.deepEqual(result, { value: { ok: false }, source: "deterministic", attempts: 2 });
    const fallback = events.at(-1);
    assert.equal(fallback?.type, "fallback");
    assert.equal(fallback?.type === "fallback" && fallback.fallback, "per-type question bank");
  });

  it("throws when a stage has no deterministic fallback", async () => {
    const { client } = scriptedClient([new Error("boom"), new Error("boom")]);
    await assert.rejects(
      runStage({
        resolved: resolveRouting().stages.editor,
        client,
        buildRequest: request,
        parse: parseJson,
      }),
      StageFailedError,
    );
  });

  it("goes straight to the fallback when no model is available", async () => {
    const { client, calls } = scriptedClient([]);
    const result = await runStage({
      resolved: resolveRouting({ available: new Set() }).stages.classifier,
      client,
      buildRequest: request,
      parse: parseJson,
      deterministic: () => ({ ok: true }),
    });
    assert.equal(result.source, "deterministic");
    assert.equal(calls.length, 0);
  });

  it("never retries a cancelled request", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const { client, calls } = scriptedClient([abort, '{"ok":true}']);
    await assert.rejects(
      runStage({
        resolved: resolveRouting().stages.planner,
        client,
        buildRequest: request,
        parse: parseJson,
      }),
      { name: "AbortError" },
    );
    assert.equal(calls.length, 1);
  });

  it("does not request reasoning from a stage that has it off", async () => {
    const { client, calls } = scriptedClient(['{"ok":true}']);
    await runStage({
      resolved: resolveRouting().stages.classifier,
      client,
      buildRequest: request,
      parse: parseJson,
    });
    assert.equal(calls[0]?.reasoning, false);
  });
});
