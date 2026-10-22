import { expect, it } from "vitest";
import * as contracts from "../../src/subscriptions/contracts/index.js";
import { NATIVE_SUBSCRIPTION_CAPABILITIES } from "../../src/subscriptions/index.js";
it("keeps contracts type-only and native unsupported capabilities explicit", () => {
  expect(Object.keys(contracts)).toEqual([]);
  expect(NATIVE_SUBSCRIPTION_CAPABILITIES.multiCyclePrepaid).toEqual({ supported: false, refusalCode: "multi_cycle_prepaid_unsupported" });
  expect(NATIVE_SUBSCRIPTION_CAPABILITIES.genericBundleCommands).toEqual({ supported: false, refusalCode: "native_generic_bundle_commands_unsupported" });
  expect(NATIVE_SUBSCRIPTION_CAPABILITIES.commandBoundReceipts).toEqual({ supported: false, refusalCode: "native_command_bound_receipts_unsupported" });
  expect(NATIVE_SUBSCRIPTION_CAPABILITIES.preparedAttemptStore.supported).toBe(false);
});
