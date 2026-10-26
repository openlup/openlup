import { expect, it, vi } from "vitest";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import type * as Local from "@openlup/platform/account-support/contracts";
import { createM12AccountReadBinding } from "./m12AccountReadBinding.js";
import type { CustomerAccountPort, CustomerOrdersPort, CustomerSubscriptionActionPort, CustomerSubscriptionPreviewPort,
  CustomerProfileMutationPort, CustomerPaymentRecoveryStartPort } from "../../domains/customers/ports.js";
import type { CustomerSubscriptionBlockReason, CustomerSubscriptionPreviewResponse } from "../../../src/domains/customers/subscriptionFacadeContracts.js";
import type { SubscriptionPaymentMethodStatus, SubscriptionRenewalBlockStatus } from "../../../src/domains/subscription/contracts.js";
import type { CommerceMoney } from "../../../src/domains/commerce/types.js";
import type { Customer360LookupRequest, Customer360SearchResponse, Customer360SnapshotResponse } from "../../../src/domains/support/customer360Contracts.js";
import type * as Support from "../../../src/domains/support/customerSupportCommandContracts.js";
import type * as Address from "../../../src/domains/support/customerSupportAddressContracts.js";
import type { OperatorLeadAbsorptionRequest, OperatorLeadAbsorptionRefusalCode } from "../../../src/domains/support/customerSubjectCorrectionContracts.js";
import type { OperatorSubscriptionCommandResult } from "../../domains/support/customerRecoveryCommand.js";
import type { CustomerSupportJourneyPort } from "../../adapters/postgres/customerSupportJourney.js";


it("binds actual reference owner types and preserves missing-account and refusal mappings", async () => {
  const failure = new Error("FORBIDDEN");
  const account: CustomerAccountPort = { getAccount: vi.fn(async () => null) };
  const orders: CustomerOrdersPort = { listOrders: vi.fn(async () => null), getOrderDetail: vi.fn(async () => { throw failure; }) };
  const binding = createM12AccountReadBinding({ account, orders });
  expect(await binding.getAccount("principal-a")).toBeNull();
  expect(await binding.listOrders("principal-b", { limit: 17 })).toBeNull();
  await expect(binding.getOrderDetail("principal-c", "order-distinct")).rejects.toBe(failure);
  expect(account.getAccount).toHaveBeenCalledExactlyOnceWith("principal-a");
  expect(orders.listOrders).toHaveBeenCalledExactlyOnceWith("principal-b", { limit: 17 });
  expect(orders.getOrderDetail).toHaveBeenCalledExactlyOnceWith("principal-c", "order-distinct");
});

// Strict equality distinguishes readonly and optional properties as well as union members.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? ((<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false) : false;
type Assert<T extends true> = T;
type Fits<A, B> = [A] extends [B] ? true : false;
type Account = Awaited<ReturnType<CustomerAccountPort["getAccount"]>>;
type Orders = Awaited<ReturnType<CustomerOrdersPort["listOrders"]>>;
type Detail = Awaited<ReturnType<CustomerOrdersPort["getOrderDetail"]>>;
type Read = Local.AccountReadPort<Exclude<Account, null>, Exclude<Orders, null>, Exclude<Detail, null>>;
type SelfService = Local.SelfServiceCommandFacade<
  Parameters<CustomerSubscriptionActionPort["applyAction"]>[1], Parameters<CustomerSubscriptionPreviewPort["previewAction"]>[1],
  Exclude<Awaited<ReturnType<CustomerSubscriptionPreviewPort["previewAction"]>>, null>,
  Exclude<Awaited<ReturnType<CustomerSubscriptionActionPort["applyAction"]>>, null>,
  Parameters<CustomerProfileMutationPort["updateProfile"]>[1], Exclude<Awaited<ReturnType<CustomerProfileMutationPort["updateProfile"]>>, null>,
  { subscriptionId: string }, { kind: "unsupported" }, { orderId: string }, { kind: "unsupported" },
  Parameters<CustomerPaymentRecoveryStartPort["startPaymentRecovery"]>[1], Exclude<Awaited<ReturnType<CustomerPaymentRecoveryStartPort["startPaymentRecovery"]>>, null>>;

export type ReferenceOwnerEquality = [
  Assert<Equal<Local.Customer360Lookup, Customer360LookupRequest>>,
  Assert<Equal<Local.EligibilityRefusal, CustomerSubscriptionBlockReason>>,
  Assert<Equal<Local.LegacySubscriptionPreviewResponse, CustomerSubscriptionPreviewResponse>>,
  Assert<Equal<Local.AccountSupportMoney, CommerceMoney>>,
  Assert<Equal<Local.SubscriptionPaymentMethodStatus, SubscriptionPaymentMethodStatus>>,
  Assert<Equal<Local.SubscriptionRenewalBlockStatus, SubscriptionRenewalBlockStatus>>,
  Assert<Equal<Local.OperatorSubscriptionAction, Support.OperatorSubscriptionActionKind>>,
  Assert<Equal<Local.OperatorSubscriptionPayload, Support.OperatorSubscriptionActionPayload>>,
  Assert<Equal<Local.OperatorSubscriptionRefusal, Support.OperatorSubscriptionRefusalCode>>,
  Assert<Equal<Local.RecoveryRefusal, Support.CustomerRecoveryRefusalCode>>,
  Assert<Equal<Local.EmailCorrectionRefusal, Support.OperatorEmailCorrectionRefusalCode>>,
  Assert<Equal<Local.PhoneCorrectionRefusal, Support.OperatorPhoneCorrectionRefusalCode>>,
  Assert<Equal<Local.OperatorNewShippingAddress, Address.OperatorNewShippingAddress>>,
  Assert<Equal<Local.OperatorShippingAddressPayload, Address.OperatorChangeShippingAddressPayload>>,
  Assert<Equal<Local.OperatorContactCommand, Support.OperatorEmailCorrectionRequest | Support.OperatorPhoneCorrectionRequest>>,
  Assert<Equal<Local.OperatorLeadCommand, OperatorLeadAbsorptionRequest>>,
  Assert<Equal<Local.LeadRefusal, OperatorLeadAbsorptionRefusalCode>>,
  Assert<Equal<Local.OperatorRecoveryCommand, Support.CustomerSupportCommandRequest>>,
  Assert<Equal<Local.OperatorSubscriptionResult, OperatorSubscriptionCommandResult>>,
  Assert<Fits<CustomerAccountPort & CustomerOrdersPort, Read>>,
  Assert<Fits<CustomerSupportJourneyPort, Local.Customer360ReadPort<Customer360SearchResponse, Customer360SnapshotResponse>>>,
  Assert<Fits<CustomerSubscriptionActionPort & CustomerSubscriptionPreviewPort, SelfService["managedSubscription"]>>,
  Assert<Fits<CustomerProfileMutationPort, SelfService["profile"]>>,
  Assert<Fits<CustomerPaymentRecoveryStartPort, SelfService["recovery"]>>
];

it("checks reference owner transcriptions and real driver fit with the TypeScript checker", () => {
  // Vitest erases TS assertions. Execute the compiler on this file so owner drift fails npm test.
  const file = fileURLToPath(import.meta.url);
  const program = ts.createProgram([file], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, skipLibCheck: true, noEmit: true,
    esModuleInterop: true, allowImportingTsExtensions: true, types: ["node"] });
  const source = program.getSourceFile(file)!;
  const diagnostics = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
  expect(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: path => path, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n",
  })).toBe("");
}, 30_000);
