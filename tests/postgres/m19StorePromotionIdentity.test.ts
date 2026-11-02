import { expect, it } from "vitest";
import * as nativeCommerce from "@openlup/platform/commerce/server/postgres";
import * as nativeSupport from "@openlup/platform/account-support/postgres";
import * as packageErrors from "@openlup/platform/account-support";
import * as readContracts from "@openlup/platform/account-support/read-contracts";
import * as rootOms from "../../server/adapters/postgres/omsControl.js";
import * as rootControl from "../../server/adapters/postgres/omsControlPlane.js";
import * as rootReturns from "../../server/adapters/postgres/returnsControl.js";
import * as rootJourney from "../../server/adapters/postgres/customerSupportJourney.js";
import * as rootCommands from "../../server/domains/support/customerRecoveryCommand.js";
import { CustomerSupportOperatorInactiveError } from "../../server/runtime/support/customerJourneyBinding.js";
import * as rootPortable from "../../src/domains/clients/portableContracts.js";
import * as rootCustomer360 from "../../src/domains/support/customer360Contracts.js";

it("keeps reference factory, refusal constructor and validation schema identities", () => {
  expect(rootOms.createPostgresCommerceOmsPort).toBe(nativeCommerce.createPostgresCommerceOmsPort);
  expect(rootOms.createPostgresProviderExceptionHealPort).toBe(nativeCommerce.createPostgresProviderExceptionHealPort);
  expect(rootControl.createPostgresCommerceOmsControlPlane).toBe(nativeCommerce.createPostgresCommerceOmsControlPlane);
  expect(rootReturns.createPostgresCommerceReturnsPort).toBe(nativeCommerce.createPostgresCommerceReturnsPort);
  expect(rootJourney.createPostgresCustomerSupportJourneyPort).toBe(nativeSupport.createPostgresCustomerSupportJourneyPort);
  expect(CustomerSupportOperatorInactiveError).toBe(packageErrors.CustomerSupportOperatorInactiveError);
  expect(rootCommands.CustomerSupportCommandInvalidError).toBe(packageErrors.CustomerSupportCommandInvalidError);
  expect(rootCommands.CustomerSupportCommandIdempotencyConflictError).toBe(packageErrors.CustomerSupportCommandIdempotencyConflictError);
  expect(rootCommands.OperatorSubscriptionAuthorityUnavailableError).toBe(packageErrors.OperatorSubscriptionAuthorityUnavailableError);
  for (const name of Object.keys(rootPortable) as (keyof typeof rootPortable)[]) {
    expect(rootPortable[name]).toBe(readContracts[name]);
  }
  for (const name of Object.keys(rootCustomer360) as (keyof typeof rootCustomer360)[]) {
    expect(rootCustomer360[name]).toBe(readContracts[name]);
  }
});

it("retains instanceof mapping for SQL refusals through the native root facade", async () => {
  const cases = [
    ["42501", CustomerSupportOperatorInactiveError, packageErrors.CustomerSupportOperatorInactiveError],
    ["22023", rootCommands.CustomerSupportCommandInvalidError, packageErrors.CustomerSupportCommandInvalidError],
    ["23505", rootCommands.CustomerSupportCommandIdempotencyConflictError, packageErrors.CustomerSupportCommandIdempotencyConflictError],
    ["42883", rootCommands.OperatorSubscriptionAuthorityUnavailableError, packageErrors.OperatorSubscriptionAuthorityUnavailableError],
  ] as const;
  for (const [code, error, builtPackageError] of cases) {
    const port = rootJourney.createPostgresCustomerSupportJourneyPort({ connectionString: "fixture", operatorId: "actor" }, {
      createLane: () => ({ run: async () => { throw Object.assign(new Error("synthetic SQL refusal"), { code }); }, close: async () => undefined }),
    });
    const thrown = await port.absorbLead({ customerId: "customer", leadId: "lead", expectedLeadEmail: "lead@example.invalid", idempotencyKey: "identity-proof", operatorId: "actor" })
      .then(() => { throw new Error("expected_packaged_refusal"); }, error => error);
    expect(thrown).toBeInstanceOf(error);
    expect(thrown).toBeInstanceOf(builtPackageError);
    await port.close();
  }
});
