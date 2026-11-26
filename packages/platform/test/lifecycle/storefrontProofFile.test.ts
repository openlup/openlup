import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseStorefrontProofFile, storefrontProofFileJsonSchema, type StorefrontProofFile } from "../../src/lifecycle/index.js";

function completeProofFile(): StorefrontProofFile {
  return {
    formatVersion: 1,
    configurations: ["default", "subscription_only"],
    widths: [390, 1280],
    routes: {
      surfaces: { product: "/products/first", cart: "/cart", checkout: "/checkout", account: "/account" },
      selectionEntry: { one_time: "/start?mode=one_time", subscription: "/start?mode=subscription" },
    },
    autoProgress: ["continue_payment"],
    changedPayloadPolicy: "update_in_place",
    buyer: { first_name: "Ada", city: "Example City" },
    recheck: "npm run proof -- --scenario {scenario}",
    adapterModule: "proof/storefront-adapter.ts",
    host: { anything: [1] },
  };
}

function parse(value: unknown) {
  return parseStorefrontProofFile(JSON.stringify(value));
}

function refusalOf(value: unknown) {
  const result = typeof value === "string" ? parseStorefrontProofFile(value) : parse(value);
  if (result.ok) throw new Error(`expected a refusal for ${JSON.stringify(value)}`);
  return result.refusal;
}

const schemaParser = z.fromJSONSchema(storefrontProofFileJsonSchema as z.core.JSONSchema.JSONSchema);

describe("parseStorefrontProofFile", () => {
  it("P1 parses a complete and a minimal proof file", () => {
    const complete = completeProofFile();
    expect(parse(complete)).toEqual({ ok: true, proofFile: complete });
    const minimal = { formatVersion: 1, configurations: ["default"], widths: [390] };
    expect(parse(minimal)).toEqual({ ok: true, proofFile: minimal });
  });

  it("P2 keeps unknown fields", () => {
    const proofFile = { ...completeProofFile(), hostField: { kept: true } };
    expect(parse(proofFile)).toEqual({ ok: true, proofFile });
  });

  it("P3 refuses a missing or empty widths list with four parts", () => {
    const { widths: _widths, ...withoutWidths } = completeProofFile();
    for (const value of [withoutWidths, { ...completeProofFile(), widths: [] }]) {
      const refusal = refusalOf(value);
      expect(refusal.code).toBe("storefront_proof_file_invalid");
      expect(refusal.observed).toBe("widths");
      for (const part of [refusal.observed, refusal.cause, refusal.fix, refusal.recheck]) expect(part.length).toBeGreaterThan(0);
    }
  });

  it("P4 refuses a higher format version by name", () => {
    const refusal = refusalOf({ ...completeProofFile(), formatVersion: 2 });
    expect(refusal.code).toBe("storefront_proof_file_version_unsupported");
    expect(refusal.observed).toContain("2");
  });

  it("P5 accepts only local paths", () => {
    const routes = (surfaces: Record<string, string>, selectionEntry: Record<string, string> = {}) => ({ ...completeProofFile(), routes: { surfaces, selectionEntry } });
    const refused: [unknown, string][] = [
      [routes({ cart: "https://shop.example.test/cart" }), "routes.surfaces.cart"],
      [routes({ cart: "//host/cart" }), "routes.surfaces.cart"],
      [routes({ cart: "/cart\\x" }), "routes.surfaces.cart"],
      [routes({ cart: "/cart?x=1" }), "routes.surfaces.cart"],
      [routes({}, { one_time: "https://shop.example.test/start" }), "routes.selectionEntry.one_time"],
      [routes({}, { one_time: "/start#top" }), "routes.selectionEntry.one_time"],
    ];
    for (const adapterModule of ["/abs.ts", "https://x/a.ts", "file:a.ts", "a\\b.ts", "a.ts?x", "../x.ts", "./a.ts", "a//b.ts", "a/./b.ts"]) {
      refused.push([{ ...completeProofFile(), adapterModule }, "adapterModule"]);
    }
    for (const [value, path] of refused) {
      const refusal = refusalOf(value);
      expect(refusal.code, JSON.stringify(value)).toBe("storefront_proof_file_invalid");
      expect(refusal.observed, JSON.stringify(value)).toBe(path);
    }
    for (const accepted of [routes({ cart: "/" }, { one_time: "/start?mode=one_time&x=1" }), { ...completeProofFile(), adapterModule: "a/.hidden/..b/x.ts" }]) {
      expect(parse(accepted)).toEqual({ ok: true, proofFile: accepted });
    }
  });

  it("P7 keeps host fields verbatim and refuses buyer.email", () => {
    const hosted = { ...completeProofFile(), host: { anything: [1], nested: { deep: null } } };
    expect(parse(hosted)).toEqual({ ok: true, proofFile: hosted });
    const refusal = refusalOf({ ...completeProofFile(), buyer: { email: "x@example.test" } });
    expect(refusal.code).toBe("storefront_proof_file_invalid");
    expect(refusal.observed).toBe("buyer.email");
  });

  it("never throws on malformed input", () => {
    for (const text of ["{", "null", "[]", "1"]) expect(refusalOf(text).observed).toBe("(root)");
  });
});

describe("storefrontProofFileJsonSchema", () => {
  it("P6 agrees with the parser over P1–P7 and a generated corpus", () => {
    const base = completeProofFile() as Record<string, unknown>;
    const values: unknown[] = [base, { formatVersion: 1, configurations: ["default"], widths: [390] }, "{", null, [], 1, { ...base, formatVersion: 2 }];
    for (const key of Object.keys(base)) {
      const removed = { ...base };
      delete removed[key];
      values.push(removed);
      for (const value of [null, true, 0, 1.5, "text", "", [], {}, ["x"], [0], { a: "/x" }]) values.push({ ...base, [key]: value });
    }
    for (const adapterModule of ["/abs.ts", "https://x/a.ts", "file:a.ts", "a\\b.ts", "a.ts?x", "../x.ts", "./a.ts", "a/b.ts"]) values.push({ ...base, adapterModule });
    for (const path of ["/", "/a", "//a", "a", "/a?b", "/a#b", "/a\\b"]) {
      values.push({ ...base, routes: { surfaces: { cart: path } } }, { ...base, routes: { selectionEntry: { one_time: path } } });
    }
    values.push({ ...base, buyer: { email: "x@example.test" } }, { ...base, buyer: { phone: 1 } }, { ...base, changedPayloadPolicy: "Refuse" });
    const disagreements: string[] = [];
    for (const value of values) {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      let json: unknown;
      try { json = JSON.parse(text); } catch { json = Symbol("not json"); }
      if (schemaParser.safeParse(json).success !== parseStorefrontProofFile(text).ok) disagreements.push(text);
    }
    expect(disagreements).toEqual([]);
    expect(Object.isFrozen(storefrontProofFileJsonSchema)).toBe(true);
    expect(storefrontProofFileJsonSchema.$schema).toBe("http://json-schema.org/draft-07/schema#");
  });
});
