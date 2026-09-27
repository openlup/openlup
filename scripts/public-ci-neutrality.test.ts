import { describe, expect, it } from "vitest";
import { neutralityIncreases, validateBaseline } from "./public-ci-neutrality.mjs";

describe("tree-wide neutrality ratchet", () => {
  it("does not let decreases in another path or category pay for new debt", () => {
    expect(neutralityIncreases({ a: { brand: 3 }, b: { brand: 2 } }, { a: { brand: 2 }, b: { brand: 3 } })).toEqual([{ path: "b", category: "brand", before: 2, after: 3 }]);
    expect(neutralityIncreases({ a: { brand: 3 } }, { a: { brand: 2, vendor: 1 } })).toEqual([{ path: "a", category: "vendor", before: 0, after: 1 }]);
  });
  it("refuses newly contaminated paths and permits shrinking or deleting findings", () => {
    expect(neutralityIncreases({}, { newPath: { brand: 1 } })).toHaveLength(1);
    expect(neutralityIncreases({ a: { brand: 3 } }, { a: { brand: 2 } })).toEqual([]);
    expect(neutralityIncreases({ a: { brand: 3 } }, {})).toEqual([]);
  });
  it("refuses malformed counts", () => {
    for (const count of [-1, 1.5, NaN, "1"]) expect(() => neutralityIncreases({}, { a: { brand: count } })).toThrow("nonnegative integers");
  });
  it("rejects malformed baseline digests, categories and accepted counts", () => {
    const baseline = { schemaVersion: 1, sourceCommit: "a".repeat(40), counts: { ["b".repeat(64)]: { brand: 1 } } };
    expect(() => validateBaseline(baseline)).not.toThrow();
    expect(() => validateBaseline({ ...baseline, sourceCommit: "main" })).toThrow();
    expect(() => validateBaseline({ ...baseline, counts: { path: { brand: 1 } } })).toThrow();
    for (const counts of [{ brand: "10" }, { brand: -1 }, { unknown: 1 }]) expect(() => validateBaseline({ ...baseline, counts: { ["b".repeat(64)]: counts } })).toThrow();
  });
});
