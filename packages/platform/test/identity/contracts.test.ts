import { expect, it } from "vitest";
import { AUTH_RECONCILE_CONTRACT_VERSION, parseSocialProviders } from "../../src/identity/contracts/index.js";
it("exposes the isolated browser value contract", () => {
  expect(AUTH_RECONCILE_CONTRACT_VERSION).toBe("auth.reconcile.v1");
  expect(parseSocialProviders("")).toEqual([]);
});

it("reads historical account subscription cadence DTOs", async () => {
  const { customerMeResponseSchema } = await import("../../src/identity/customerContracts.js");
  const cadence = customerMeResponseSchema.shape.subscriptions.unwrap().element.shape.cadenceDays;
  for (const days of [1, 3660, 3661, 2_147_483_647]) expect(cadence.parse(days)).toBe(days);
  for (const days of [0, 1.5, 2_147_483_648, Infinity]) expect(cadence.safeParse(days).success).toBe(false);
});
