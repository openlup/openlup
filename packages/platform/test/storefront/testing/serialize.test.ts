import { describe, expect, it } from "vitest";
import { parseStorefrontVerdict, type StorefrontVerdict } from "../../../src/lifecycle/index.js";
import { serializeStorefrontVerdict } from "../../../src/storefront/testing/index.js";

const digest = `sha256:${"cd".repeat(32)}`;

function verdict(): StorefrontVerdict {
  return {
    formatVersion: 1,
    runId: "run-0002-serialize",
    completedAt: "2025-06-01T00:00:00.000Z",
    scenario: "duplicate_submit",
    tier: "fixture_preview",
    profile: "default",
    channel: "browser_ui",
    width: 390,
    result: "safety_only",
    control: { kind: "none", negates: null, applied: false },
    stimulus: { create: 2 },
    steps: [{
      index: 0, run: "clean", phase: "stimulus", action: "place_order", expectedAnchor: null,
      observedAnchors: ["state:awaiting_payment"], path: "/checkout", elapsedMs: 210,
      commands: [{ operation: "create", ordinal: 0, key: { present: true, sameAs: null } }],
      ledger: { orders: 1, payableOrders: 1, holds: 1, attempts: 0, captures: 0 },
    }],
    findings: [],
    build: { source: "claimed", packages: [{ name: "@openlup/platform", version: "1.0.0" }], clients: [{ name: "web", digest }], proofFile: null },
    harness: { runnerVersion: "1.0.0", catalogueVersion: 1, adapter: { kind: "default", fields: [], digest: null }, autoProgress: [], observer: "fixture", declaredOutcomes: [] },
    durations: { totalMs: 210, byPhase: { stimulus: 210 } },
  };
}

/** The same value with every object's keys sorted by UTF-16 code units, reversed when `reverse` is set. */
function reordered(value: unknown, reverse: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => reordered(item, reverse));
  if (value === null || typeof value !== "object") return value;
  const keys = Object.keys(value).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (reverse) keys.reverse();
  return Object.fromEntries(keys.map((key) => [key, reordered((value as Record<string, unknown>)[key], reverse)]));
}

describe("serializeStorefrontVerdict (S1)", () => {
  it("writes two-space JSON with sorted keys and a line feed that the parser reads back to the same verdict", () => {
    const value = verdict();
    const text = serializeStorefrontVerdict(value);
    expect(text).toBe(`${JSON.stringify(reordered(value, false), null, 2)}\n`);
    expect(text.indexOf('"build"')).toBeLessThan(text.indexOf('"formatVersion"'));
    const parsed = parseStorefrontVerdict(text);
    expect(parsed).toEqual({ ok: true, verdict: value });
  });

  it("writes the same bytes for equal verdicts built in different key orders", () => {
    const forward = reordered(verdict(), false) as StorefrontVerdict;
    const backward = reordered(verdict(), true) as StorefrontVerdict;
    expect(Object.keys(forward)).not.toEqual(Object.keys(backward));
    expect(serializeStorefrontVerdict(backward)).toBe(serializeStorefrontVerdict(forward));
  });

  it.each([
    ["a function", (v: Record<string, unknown>) => { v.extra = () => 1; }, "extra"],
    ["an undefined member", (v: Record<string, unknown>) => { (v.control as Record<string, unknown>).action = undefined; }, "control.action"],
    ["NaN", (v: Record<string, unknown>) => { (v.durations as Record<string, unknown>).totalMs = Number.NaN; }, "durations.totalMs"],
    ["Infinity", (v: Record<string, unknown>) => { v.width = Number.POSITIVE_INFINITY; }, "width"],
    ["a Date", (v: Record<string, unknown>) => { v.completedAt = new Date(0); }, "completedAt"],
    ["a bigint", (v: Record<string, unknown>) => { (v.stimulus as Record<string, unknown>).create = 2n; }, "stimulus.create"],
    ["a symbol", (v: Record<string, unknown>) => { v.extra = Symbol("x"); }, "extra"],
    ["a Map", (v: Record<string, unknown>) => { v.extra = new Map(); }, "extra"],
    ["an undefined array item", (v: Record<string, unknown>) => { (v.harness as Record<string, unknown>).autoProgress = [undefined]; }, "harness.autoProgress[0]"],
    ["a cycle", (v: Record<string, unknown>) => { v.extra = v; }, "extra"],
  ])("refuses %s instead of coercing it", (_name, mutate, path) => {
    const value = verdict() as unknown as Record<string, unknown>;
    mutate(value);
    let thrown: unknown;
    try { serializeStorefrontVerdict(value as unknown as StorefrontVerdict); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as TypeError).message.startsWith(`storefront_verdict_invalid: ${path} `)).toBe(true);
    for (const part of [" Cause: ", " Fix: ", " Recheck: "]) expect((thrown as TypeError).message).toContain(part);
  });

  it("throws a TypeError naming the refusal's code and four parts for a browser verdict without a width", () => {
    const { width: _width, ...withoutWidth } = verdict();
    let thrown: unknown;
    try { serializeStorefrontVerdict(withoutWidth); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(TypeError);
    const refusal = parseStorefrontVerdict(`${JSON.stringify(withoutWidth, null, 2)}\n`);
    if (refusal.ok) throw new Error("expected the parser to refuse a browser verdict without a width");
    const message = (thrown as TypeError).message;
    expect(message.startsWith("storefront_verdict_invalid")).toBe(true);
    for (const part of [refusal.refusal.observed, refusal.refusal.cause, refusal.refusal.fix, refusal.refusal.recheck]) {
      expect(part.length).toBeGreaterThan(0);
      expect(message).toContain(part);
    }
    expect(message).toContain("width");
  });

  it("refuses a value that is not a verdict at all", () => {
    expect(() => serializeStorefrontVerdict(undefined as unknown as StorefrontVerdict)).toThrow(TypeError);
    expect(() => serializeStorefrontVerdict({ ...verdict(), formatVersion: 2 } as unknown as StorefrontVerdict)).toThrow(/storefront_verdict_version_unsupported/);
  });
});
