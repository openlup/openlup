import { expect, expectTypeOf, it } from "vitest";
import * as contracts from "../../src/subscriptions/contracts/index.js";
import { NATIVE_SUBSCRIPTION_CAPABILITIES } from "../../src/subscriptions/index.js";
import type { PreparedAttemptPrepareInput, PreparedAttemptPersistenceResult, PreparedAttemptFinalizeInput,
  PreparedAttemptPersistencePort } from "../../src/payments/contracts/index.js";
import type { RenewalPreparedAttemptPrepareInput, RenewalPreparedAttemptPersistenceResult,
  RenewalPreparedAttemptFinalizeInput, RenewalPreparedAttemptPersistencePort } from "../../src/subscriptions/contracts/index.js";

it("keeps contracts type-only and native unsupported capabilities explicit", () => {
  expect([NATIVE_SUBSCRIPTION_CAPABILITIES, ...Object.values(NATIVE_SUBSCRIPTION_CAPABILITIES).filter(value => typeof value === "object")].every(Object.isFrozen)).toBe(true);
  expect(Object.keys(contracts)).toEqual([]);
  expect(NATIVE_SUBSCRIPTION_CAPABILITIES.multiCyclePrepaid).toEqual({ supported: false, refusalCode: "multi_cycle_prepaid_unsupported" });
  expect(NATIVE_SUBSCRIPTION_CAPABILITIES.genericBundleCommands).toEqual({ supported: true });
  expect(NATIVE_SUBSCRIPTION_CAPABILITIES.commandBoundReceipts).toEqual({ supported: true });
  expect(NATIVE_SUBSCRIPTION_CAPABILITIES.preparedAttemptStore.supported).toBe(false);
});

it("keeps Renewal projections mutually assignable with M07, including narrowed generics", () => {
  expectTypeOf<RenewalPreparedAttemptPrepareInput>().toExtend<PreparedAttemptPrepareInput>();
  expectTypeOf<PreparedAttemptPrepareInput>().toExtend<RenewalPreparedAttemptPrepareInput>();
  expectTypeOf<RenewalPreparedAttemptPersistenceResult>().toExtend<PreparedAttemptPersistenceResult>();
  expectTypeOf<PreparedAttemptPersistenceResult>().toExtend<RenewalPreparedAttemptPersistenceResult>();
  expectTypeOf<RenewalPreparedAttemptFinalizeInput>().toExtend<PreparedAttemptFinalizeInput>();
  expectTypeOf<PreparedAttemptFinalizeInput>().toExtend<RenewalPreparedAttemptFinalizeInput>();
  expectTypeOf<RenewalPreparedAttemptPersistencePort>().toExtend<PreparedAttemptPersistencePort>();
  expectTypeOf<PreparedAttemptPersistencePort>().toExtend<RenewalPreparedAttemptPersistencePort>();
  expectTypeOf<RenewalPreparedAttemptPrepareInput<"rail">>().toEqualTypeOf<PreparedAttemptPrepareInput<"rail">>();
  expectTypeOf<RenewalPreparedAttemptPersistenceResult<"action">>().toEqualTypeOf<PreparedAttemptPersistenceResult<"action">>();
  expectTypeOf<RenewalPreparedAttemptFinalizeInput<"action">>().toEqualTypeOf<PreparedAttemptFinalizeInput<"action">>();
  expectTypeOf<RenewalPreparedAttemptPersistencePort<"rail", "action">>().toEqualTypeOf<PreparedAttemptPersistencePort<"rail", "action">>();
});
