import { describe, expect, it } from "vitest";

import {
  assertActivateNotMachineActor,
  evaluateLifecycleRules,
} from "./lifecycleRules.js";

describe("agent-domain lifecycle rules", () => {
  it("blocks a machine actor from activating", () => {
    expect(assertActivateNotMachineActor({ operation: "activate", actorKind: "machine" })).toBe(
      "DRAFT_ONLY_FOR_MACHINE",
    );
  });

  it("allows a human actor to activate", () => {
    expect(assertActivateNotMachineActor({ operation: "activate", actorKind: "human" })).toBeNull();
  });

  it("allows a machine actor to perform non-activate operations", () => {
    expect(assertActivateNotMachineActor({ operation: "create_draft", actorKind: "machine" })).toBeNull();
    expect(assertActivateNotMachineActor({ operation: "set_price", actorKind: "machine" })).toBeNull();
  });

  it("aggregates violations into a RuleResult", () => {
    expect(evaluateLifecycleRules({ operation: "activate", actorKind: "machine" })).toEqual({
      ok: false,
      violations: ["DRAFT_ONLY_FOR_MACHINE"],
    });
    expect(evaluateLifecycleRules({ operation: "archive", actorKind: "machine" })).toEqual({
      ok: true,
      violations: [],
    });
  });
});
