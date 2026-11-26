import { expect, it } from "vitest";
import { storefrontAnchor } from "../../../src/storefront/index.js";
import { findingText, findingTextKeys } from "../../../src/storefront/testing/findings.js";
import { storefrontScenarios } from "../../../src/storefront/testing/index.js";

const isFrozenDeep = (value: unknown): boolean =>
  value === null || typeof value !== "object" || (Object.isFrozen(value) && Object.values(value).every(isFrozenDeep));

it("holds the two read scenario ids, frozen (C1)", () => {
  expect(storefrontScenarios.map((scenario) => scenario.id)).toEqual(["lost_response_reload", "duplicate_submit"]);
  expect(isFrozenDeep(storefrontScenarios)).toBe(true);
});

it("uses only storefront anchors and requires no outcome (C1)", () => {
  for (const scenario of storefrontScenarios) {
    expect(scenario.requires.outcomes, scenario.id).toEqual([]);
    for (const step of scenario.steps) {
      if (step.kind === "act") expect(Object.hasOwn(storefrontAnchor.action, step.action), `${scenario.id} ${step.action}`).toBe(true);
      if (step.kind === "expect") {
        expect(Object.hasOwn(storefrontAnchor.state, step.state), `${scenario.id} ${step.state}`).toBe(true);
        for (const offer of step.offers) expect(Object.hasOwn(storefrontAnchor.action, offer), `${scenario.id} ${offer}`).toBe(true);
      }
    }
    if (scenario.control.negates !== null) expect(Object.hasOwn(storefrontAnchor.state, scenario.control.negates)).toBe(true);
    for (const sentence of Object.values(scenario.text)) expect(sentence).toMatch(/^[A-Z].+\.$/);
  }
});

it("starts each control at a step of its scenario and negates a state it expects", () => {
  const lost = storefrontScenarios[0]!;
  expect(lost.steps[lost.control.from!]).toEqual({ kind: "reload" });
  expect(lost.steps.some((step) => step.kind === "expect" && step.state === lost.control.negates)).toBe(true);
  expect(storefrontScenarios[1]!.control).toEqual({ kind: "none", negates: null });
});

it("keys the finding texts by code and cause, with one cause per single-cause code", () => {
  const causes = (code: string) => findingTextKeys.filter(([key]) => key === code).map(([, cause]) => cause).sort();
  expect(causes("observer_subject_unseen")).toEqual(["no_order_after_create", "order_before_arrange"]);
  expect(causes("adapter_anchor_missing")).toEqual(["action", "field", "state"]);
  expect(causes("adapter_matcher_unmatched")).toEqual(["blocked_set", "create", "read"]);
  expect(causes("observer_failed")).toEqual(["rejected", "unattributable"]);
  for (const [code, cause] of findingTextKeys) {
    const text = findingText(code, cause, { at: "Step 1 (act place_order) of the clean run", count: 2, limit: 1, name: "state:paid", seen: "state:declined", detail: "hidden" });
    for (const part of Object.values(text)) expect(part, `${code} ${cause}`).toMatch(/^[A-Z].+\.$/);
  }
  expect(() => findingText("duplicate_order", "create", { at: "x" })).toThrow(TypeError);
});
