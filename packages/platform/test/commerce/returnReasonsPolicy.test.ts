import { expect, it, vi } from "vitest";
import corpus from "./commerce_return_reasons.json";
import {
  DEFAULT_COMMERCE_RETURN_REASONS,
  installCommerceReturnReasonsPolicy,
  readCommerceReturnReasonsOverride,
  readCommerceReturnReasonsPolicy,
  validateCommerceReturnReasons,
} from "../../src/commerce/returnReasonsPolicy.js";

it("defaults only for an absent row and installs validated JSON through SQL validator", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  expect(DEFAULT_COMMERCE_RETURN_REASONS).toEqual([
    "damaged", "wrong_item", "not_as_described", "pet_refused", "changed_mind", "other",
  ]);
  expect(await readCommerceReturnReasonsOverride({ query })).toBeUndefined();
  expect(await readCommerceReturnReasonsPolicy({ query })).toEqual({
    revision: "default",
    reasons: [...DEFAULT_COMMERCE_RETURN_REASONS],
  });
  const policy = { revision: "store-1", reasons: ["damaged", "box_crushed", "other"] };
  await installCommerceReturnReasonsPolicy({ query }, policy);
  expect(query.mock.lastCall?.[0]).toContain("public.commerce_return_reasons_validate($2::jsonb)::text");
  expect(query.mock.lastCall?.[1]).toEqual(["commerce_return_reasons", JSON.stringify(policy)]);
  query.mockResolvedValueOnce({ rows: [{ value_text: JSON.stringify(policy) }] });
  expect(await readCommerceReturnReasonsPolicy({ query })).toEqual(policy);
});

it("enforces the 64-item upper bound", () => {
  const maxReasons = Array.from({ length: 64 }, (_, i) => `r_${i}`);
  expect(validateCommerceReturnReasons({ revision: "r64", reasons: maxReasons }).reasons).toHaveLength(64);
  const tooMany = Array.from({ length: 65 }, (_, i) => `r_${i}`);
  expect(() => validateCommerceReturnReasons({ revision: "r65", reasons: tooMany }))
    .toThrow("commerce_return_reasons_policy_invalid");
});

it.each(corpus)("shared corpus (TS): $name", async ({ input: rawJson, accepted, normalized, code }) => {
  const input: unknown = JSON.parse(rawJson);
  if (accepted) {
    expect(validateCommerceReturnReasons(input)).toStrictEqual(normalized);
    return;
  }
  const query = vi.fn().mockResolvedValue({ rows: [{ value_text: rawJson }] });
  expect(() => validateCommerceReturnReasons(input)).toThrow(code);
  await expect(installCommerceReturnReasonsPolicy({ query }, input as never)).rejects.toThrow(code);
  expect(query).not.toHaveBeenCalled();
  await expect(readCommerceReturnReasonsPolicy({ query })).rejects.toThrow(code);
  await expect(readCommerceReturnReasonsOverride({ query })).rejects.toThrow(code);
});

it.each([null, "{bad-json", "undefined"])("names malformed persisted JSON: %j", async value_text => {
  const query = vi.fn().mockResolvedValue({ rows: [{ value_text }] });
  await expect(readCommerceReturnReasonsPolicy({ query }))
    .rejects.toThrow("commerce_return_reasons_policy_invalid");
  expect(query.mock.calls[0]?.[0]).toMatch(/^SELECT /);
});
