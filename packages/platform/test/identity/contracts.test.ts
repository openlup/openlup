import { expect, it } from "vitest";
import { AUTH_RECONCILE_CONTRACT_VERSION, parseSocialProviders } from "../../src/identity/contracts/index.js";
it("exposes the isolated browser value contract", () => {
  expect(AUTH_RECONCILE_CONTRACT_VERSION).toBe("auth.reconcile.v1");
  expect(parseSocialProviders("")).toEqual([]);
});
