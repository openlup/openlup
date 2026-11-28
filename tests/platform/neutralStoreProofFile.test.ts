/**
 * The neutral starter ships `owned/storefront-proof.json`, and its proof kit carries the same values for a store
 * extracted before the file existed. This repository-only test pins the two together and proves the shipped file is
 * a proof file the package accepts, by its parser and by its JSON Schema.
 */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import { parseStorefrontProofFile, storefrontProofFileJsonSchema } from "@openlup/platform/lifecycle";
import { shippedStorefrontProof } from "../../examples/neutral-store/browser/storefront-proof-kit.ts";

const shippedText = readFileSync(new URL("../../examples/neutral-store/owned/storefront-proof.json", import.meta.url), "utf8");

it("the shipped proof file equals the kit's shipped values", () => {
  expect(JSON.parse(shippedText)).toStrictEqual(JSON.parse(JSON.stringify(shippedStorefrontProof)));
});

it("the package parser and the proof file's JSON Schema accept the shipped file", () => {
  const parsed = parseStorefrontProofFile(shippedText);
  expect(parsed).toEqual({ ok: true, proofFile: JSON.parse(shippedText) });
  expect(z.fromJSONSchema(storefrontProofFileJsonSchema as z.core.JSONSchema.JSONSchema).safeParse(JSON.parse(shippedText)).success).toBe(true);
});

it("the shipped file declares no adapter module, buyer or host fields", () => {
  const value = JSON.parse(shippedText) as Record<string, unknown>;
  for (const field of ["adapterModule", "buyer", "host"]) expect(Object.hasOwn(value, field), field).toBe(false);
});
