import { describe, expect, it } from "vitest";
import * as lifecycle from "../../src/lifecycle/index.js";
import { storefrontCapabilities, type StorefrontCapability } from "../../src/lifecycle/index.js";

const ID = /^[a-z][a-z0-9_]*$/;
const CLOSED_BY = ["platform", "provider_module", "store"];
const FIELDS = ["appliesTo", "closedBy", "id", "level", "meanwhile", "statement"];
// The levels a package list carries in this version. A host's own levels are derived later and never appear here.
const PACKAGE_LEVELS = ["supported", "unsupported"];

const unfrozen = (value: unknown, path: string): string[] => {
  if (value === null || typeof value !== "object") return [];
  const own = Object.isFrozen(value) ? [] : [path];
  return [...own, ...Object.entries(value).flatMap(([key, child]) => unfrozen(child, `${path}.${key}`))];
};

describe("storefrontCapabilities", () => {
  it("C1 gives every entry all six fields, grammar ids, unique capability ids, a known closer and meanwhile only while unsupported", () => {
    expect(storefrontCapabilities.length).toBeGreaterThan(0);
    for (const entry of storefrontCapabilities) {
      expect(Object.keys(entry).sort(), entry.id).toEqual(FIELDS);
      expect(entry.id).toMatch(ID);
      expect(Object.keys(entry.appliesTo).sort(), entry.id).toEqual(["id", "text"]);
      expect(entry.appliesTo.id, entry.id).toMatch(ID);
      expect(CLOSED_BY, entry.id).toContain(entry.closedBy);
      expect(entry.statement, entry.id).toMatch(/^[A-Z][^.]*[a-z]$/);
      expect(entry.meanwhile === null, entry.id).toBe(entry.level === "supported");
      if (entry.meanwhile !== null) expect(entry.meanwhile, entry.id).toMatch(/^[A-Z].+\.$/);
    }
    const ids = storefrontCapabilities.map((entry) => entry.id);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });

  it("C1 states each level explicitly and only as a package level, one token for every unsupported entry", () => {
    for (const entry of storefrontCapabilities) {
      // An absent level is refused, never read as unsupported: the field is an own string on every entry.
      expect(Object.hasOwn(entry, "level") && typeof entry.level === "string", entry.id).toBe(true);
      expect(PACKAGE_LEVELS, entry.id).toContain(entry.level);
    }
    expect([...new Set(storefrontCapabilities.filter((entry) => entry.level !== "supported").map((entry) => entry.level))]).toEqual(["unsupported"]);
  });

  it("C2 is frozen at every depth, and a write throws", () => {
    expect(Array.isArray(storefrontCapabilities) && storefrontCapabilities.length > 0).toBe(true);
    expect(unfrozen(storefrontCapabilities, "storefrontCapabilities")).toEqual([]);
    expect(() => { (storefrontCapabilities as StorefrontCapability[]).push(storefrontCapabilities[0]!); }).toThrow(TypeError);
    expect(() => { (storefrontCapabilities[0] as { level: string }).level = "supported"; }).toThrow(TypeError);
    expect(() => { (storefrontCapabilities[0]!.appliesTo as { text: string }).text = "x"; }).toThrow(TypeError);
  });

  it("C3 words each condition as the stores it affects, and never says a store cannot sell", () => {
    for (const entry of storefrontCapabilities) {
      expect(entry.appliesTo.text, entry.id).toMatch(/^Stores (that|whose) /);
      for (const text of [entry.statement, entry.meanwhile ?? "", entry.appliesTo.text]) expect(text.toLowerCase(), entry.id).not.toContain("cannot sell");
    }
  });

  it("C4 is a runtime key of the lifecycle entry", () => {
    expect(Object.keys(lifecycle)).toContain("storefrontCapabilities");
    expect(lifecycle.storefrontCapabilities).toBe(storefrontCapabilities);
  });
});
