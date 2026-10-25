import { expect, expectTypeOf, it } from "vitest";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import type * as Local from "../../src/account-support/contracts/index.js";
import type * as Subscription from "../../src/subscriptions/contracts/index.js";
import type { NativeSubscriptionCommand, createPostgresSubscriptionCommands, createPostgresSubscriptionCommandStore } from "../../src/subscriptions/index.js";
import type { InvoiceHostPorts, InvoiceDocumentIdentity, InvoiceUnsupported, InvoiceClearanceObservation } from "../../src/invoicing/contracts/index.js";
// Strict equality distinguishes readonly and optional properties as well as union members.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? ((<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false) : false;
type Assert<T extends true> = T;
type Fits<A, B> = [A] extends [B] ? true : false;
type SelfService = Local.SelfServiceCommandFacade<
  unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown>;

export type OwnerEquality = [
  Assert<Equal<Local.OperatorRecoveryCommandEnvelope["actor"]["isMachineActor"], false>>,
  Assert<Equal<Local.OperatorRecoveryCommandEnvelope["reason"], string | null>>,
  Assert<Equal<Local.SubscriptionCommandContext, Subscription.SubscriptionCommandContext>>,
  Assert<Equal<Local.SubscriptionCommand, Subscription.SubscriptionCommand>>,
  Assert<Equal<Local.SubscriptionBundleLine, Subscription.SubscriptionBundleLine>>,
  Assert<Equal<Local.SubscriptionCommandReceipt, Subscription.SubscriptionCommandReceipt>>,
  Assert<Equal<Local.SubscriptionCommandRefusal, Subscription.SubscriptionCommandRefusal>>,
  Assert<Equal<Local.SubscriptionUnsupportedCode, Subscription.SubscriptionUnsupportedCode>>,
  Assert<Equal<Local.SubscriptionUnsupported, Subscription.SubscriptionUnsupported>>,
  Assert<Equal<Local.SubscriptionCapabilities, Subscription.SubscriptionCapabilities>>,
  Assert<Equal<Local.NativeSubscriptionCommand, NativeSubscriptionCommand>>,
  Assert<Equal<Local.InvoiceDocumentIdentity, InvoiceDocumentIdentity>>,
  Assert<Equal<Local.InvoiceUnsupported, InvoiceUnsupported>>,
  Assert<Equal<Local.InvoiceClearanceState, InvoiceClearanceObservation["state"]>>,
  Assert<Equal<Local.InvoiceAccessPort, InvoiceHostPorts["accountHistory"]>>,
  Assert<Fits<ReturnType<typeof createPostgresSubscriptionCommandStore>, SelfService["nativeRawSubscription"]>>,
  Assert<Fits<ReturnType<typeof createPostgresSubscriptionCommands>, SelfService["nativeSubscription"]>>,
  Assert<Equal<Local.AccountSupportCapabilities, {
    graph: "managed" | "native";
    accountRead: Local.AccountSupportCapability<"host_binding_required">;
    customer360Read: Local.AccountSupportCapability<"host_binding_required">;
    invoiceAccess: Local.AccountSupportCapability<"host_binding_required">;
    paymentMethodSetup: Local.AccountSupportCapability<"unsupported">;
    commerceRecovery: Local.AccountSupportCapability<"host_binding_required">;
    configuredPurchase: Local.AccountSupportCapability<"host_binding_required">;
    operatorSubscription: Local.AccountSupportCapability<"operator_subscription_authority_unavailable">;
    operatorContact: Local.AccountSupportCapability<"operator_subscription_authority_unavailable">;
    subscriptions: Subscription.SubscriptionCapabilities;
    communicationGifts: Local.AccountSupportCapability<"unsupported_preference">;
  }>>
];

it("checks packaged owner transcriptions, driver fit and capability shape with the TypeScript checker", () => {
  expectTypeOf<Local.InvoiceAccessPort>().toEqualTypeOf<InvoiceHostPorts["accountHistory"]>();
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
