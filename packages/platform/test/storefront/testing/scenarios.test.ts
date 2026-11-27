import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import { knownFindingCodes } from "../../../src/lifecycle/storefrontVerdictSchema.js";
import { storefrontAnchor } from "../../../src/storefront/index.js";
import { findingParts, findingText, findingTextKeys, partLabels } from "../../../src/storefront/testing/findings.js";
import { JUDGEMENT } from "../../../src/storefront/testing/judgement.js";
import { knownOutcomes, outcomeMeanings } from "../../../src/storefront/testing/outcomes.js";
import { storefrontScenarios, type StorefrontScenario } from "../../../src/storefront/testing/index.js";

const isFrozenDeep = (value: unknown): boolean =>
  value === null || typeof value !== "object" || (Object.isFrozen(value) && Object.values(value).every(isFrozenDeep));

const READ_IDS = ["lost_response_reload", "duplicate_submit", "lost_response_edited_payload", "reload_pending_attempt", "decline_retry", "paid_pending_activation"];

it("holds the six read scenario ids, unique and frozen (C1, C2)", () => {
  expect(storefrontScenarios.map((scenario) => scenario.id)).toEqual(READ_IDS);
  expect(new Set(storefrontScenarios.map((scenario) => scenario.id)).size).toBe(6);
  expect(isFrozenDeep(storefrontScenarios)).toBe(true);
});

it("uses only storefront anchors, and requires exactly the outcomes its steps use (C1, C2)", () => {
  for (const scenario of storefrontScenarios) {
    const used = new Set<string>();
    for (const step of scenario.steps) {
      if (step.kind === "act") expect(Object.hasOwn(storefrontAnchor.action, step.action), `${scenario.id} ${step.action}`).toBe(true);
      if (step.kind === "outcome") used.add(step.outcome);
      if (step.kind === "expect") {
        for (const progress of [step, ...Object.values(step.byPolicy ?? {})]) {
          expect(Object.hasOwn(storefrontAnchor.state, progress.state), `${scenario.id} ${progress.state}`).toBe(true);
          for (const offer of progress.offers) expect(Object.hasOwn(storefrontAnchor.action, offer), `${scenario.id} ${offer}`).toBe(true);
        }
      }
    }
    expect([...scenario.requires.outcomes].sort(), scenario.id).toEqual([...used].sort());
    if (scenario.control.negates !== null) expect(Object.hasOwn(storefrontAnchor.state, scenario.control.negates)).toBe(true);
    if (scenario.control.action !== undefined) expect(Object.hasOwn(storefrontAnchor.action, scenario.control.action)).toBe(true);
    const forbidden = scenario.safety.forbiddenStates;
    const named = forbidden === undefined ? [] : [
      ...forbidden.control, ...forbidden.clean.ruledOut,
      ...(forbidden.clean.afterShowing === undefined ? [] : [forbidden.clean.afterShowing.state, ...forbidden.clean.afterShowing.regressions]),
    ];
    for (const state of named) expect(Object.hasOwn(storefrontAnchor.state, state), `${scenario.id} ${state}`).toBe(true);
    for (const sentence of Object.values(scenario.text)) expect(sentence).toMatch(/^[A-Z].+\.$/);
  }
});

it("forbids, per run, the outcomes a paid_pending_activation run must not show", () => {
  const scenario = storefrontScenarios.find((entry) => entry.id === "paid_pending_activation")!;
  expect(scenario.safety.forbiddenStates).toEqual({
    control: ["paid", "declined"],
    clean: { ruledOut: ["paid", "declined"], afterShowing: { state: "paid_pending_activation", regressions: ["awaiting_payment"] } },
  });
});

it("starts each control at a step of its scenario and negates a state it expects", () => {
  const byId = (id: string) => storefrontScenarios.find((scenario) => scenario.id === id)!;
  const expects = (scenario: StorefrontScenario) => scenario.steps.flatMap((step) => step.kind === "expect" ? [step.state, ...Object.values(step.byPolicy ?? {}).map((progress) => progress.state)] : []);
  for (const id of ["lost_response_reload", "reload_pending_attempt"]) expect(byId(id).steps[byId(id).control.from!], id).toEqual({ kind: "reload" });
  expect(byId("paid_pending_activation").steps[byId("paid_pending_activation").control.from!]).toEqual({ kind: "outcome", outcome: "activation_pending" });
  for (const scenario of storefrontScenarios) {
    if (scenario.control.negates !== null) expect(expects(scenario), scenario.id).toContain(scenario.control.negates);
  }
  const decline = byId("decline_retry");
  expect(decline.steps.some((step) => step.kind === "act" && step.action === decline.control.action)).toBe(true);
  expect(byId("lost_response_edited_payload").control).toEqual({ kind: "other_policy", negates: null });
  expect(byId("duplicate_submit").control).toEqual({ kind: "none", negates: null });
});

it("keys the finding texts by code and cause, with one cause per single-cause code", () => {
  const causes = (code: string) => findingTextKeys.filter(([key]) => key === code).map(([, cause]) => cause).sort();
  expect(causes("observer_subject_unseen")).toEqual(["no_order_after_create", "order_before_arrange"]);
  expect(causes("adapter_anchor_missing")).toEqual(["action", "field", "state"]);
  expect(causes("adapter_matcher_unmatched")).toEqual(["blocked_set", "create", "read"]);
  expect(causes("observer_failed")).toEqual(["rejected", "unattributable"]);
  expect(causes("outcome_failed")).toEqual(["no_attempt", "no_effect", "rejected"]);
  expect(causes("forbidden_state_shown")).toEqual(["paid_without_capture", "regression", "ruled_out", "unknowable"]);
  expect(causes("vacuous_progress")).toEqual(["blocked", "omitted", "other_policy"]);
  for (const [code, cause] of findingTextKeys) {
    const text = findingText(code, cause, { at: "Step 1 (act place_order) of the clean run", count: 2, limit: 1, name: "state:paid", seen: "state:declined", detail: "hidden" });
    for (const part of Object.values(text)) expect(part, `${code} ${cause}`).toMatch(/^[A-Z].+\.$/);
  }
  expect(() => findingText("duplicate_order", "create", { at: "x" })).toThrow(TypeError);
  // The control list is judged from the control run's first sample, before its control starts too.
  const unknowable = findingText("forbidden_state_shown", "unknowable", { at: "Step 2 (expect awaiting_payment) of the control run", name: "state:paid" });
  expect(`${unknowable.observed} ${unknowable.cause}`).not.toMatch(/blocked/);
});

const tableCodes = () => [...new Set(findingTextKeys.map(([code]) => code))];

it("F1 holds a text for every known finding code and no other code", () => {
  expect(tableCodes().sort()).toEqual([...knownFindingCodes].sort());
});

it("F2 names exactly one part at fault for every finding code", () => {
  expect(Object.keys(findingParts).sort()).toEqual([...knownFindingCodes].sort());
  for (const code of knownFindingCodes) expect(Object.keys(partLabels), code).toContain(findingParts[code]);
});

it("F3 names, per code, the part the StorefrontFindingCode documentation names", () => {
  const path = new URL("../../../src/lifecycle/storefrontVerdict.ts", import.meta.url);
  const source = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.ES2022, true);
  const alias = source.statements.find((node): node is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(node) && node.name.text === "StorefrontFindingCode");
  const comment = ts.getJSDocCommentsAndTags(alias!).filter(ts.isJSDoc).map((doc) => ts.getTextOfJSDocComment(doc.comment) ?? "").join("\n");
  const byLabel = new Map(Object.entries(partLabels).map(([part, label]) => [label, part]));
  const documented: Record<string, string> = {};
  for (const bullet of comment.split(/\n- /).slice(1)) {
    const label = bullet.slice(0, bullet.indexOf(":"));
    expect([...byLabel.keys()], label).toContain(label);
    const codes = [...bullet.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((match) => match[1]!).filter((name) => (knownFindingCodes as readonly string[]).includes(name));
    for (const code of codes) {
      expect(documented[code], `${code} is documented twice`).toBeUndefined();
      documented[code] = byLabel.get(label)!;
    }
  }
  expect(documented).toEqual({ ...findingParts });
});

it("F4 covers every (code, cause) of the table with a judgement entry, and every judgement entry with the table", () => {
  const keys = Object.keys(JUDGEMENT);
  for (const [code, cause] of findingTextKeys) expect(keys.includes(`${code}:${cause}`) || keys.includes(code), `${code}:${cause}`).toBe(true);
  const causesOf = (code: string) => findingTextKeys.filter(([key]) => key === code).map(([, cause]) => cause);
  for (const key of keys) {
    const [code, cause] = key.split(":") as [string, string | undefined];
    expect(causesOf(code), `${key} names a code the table does not hold`).not.toEqual([]);
    if (cause !== undefined) expect(causesOf(code), `${key} names a cause the table does not hold`).toContain(cause);
  }
  for (const code of tableCodes()) {
    const split = keys.filter((key) => key.startsWith(`${code}:`));
    if (split.length === 0) continue;
    expect(split.sort(), `${code} splits its judgement, so every cause needs a split key`).toEqual(causesOf(code).map((cause) => `${code}:${cause}`).sort());
    expect(keys, `${code} splits its judgement, so a plain key is never read`).not.toContain(code);
  }
});

it("gives every known outcome kind a one-line meaning", () => {
  expect(Object.keys(outcomeMeanings).sort()).toEqual([...knownOutcomes].sort());
  for (const meaning of Object.values(outcomeMeanings)) expect(meaning).toMatch(/^[A-Z][^\n]+\.$/);
});
