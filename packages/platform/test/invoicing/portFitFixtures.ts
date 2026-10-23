import { readFileSync } from "node:fs";
import { expect } from "vitest";
import type { InvoiceFacts, InvoiceLine, InvoiceBuyer, InvoiceSeller, InvoiceIdentity, InvoiceHostPorts, InvoiceStorePort } from "../../src/invoicing/contracts/index.js";

// Synthetic translation of providerPorts/LocalInvoiceSnapshot and the canonical
// position carrier. No live adapter, jurisdiction, config or upstream reread.
export const seller: InvoiceSeller = { name: "Example seller", address: { line1: "Example 1", postalCode: "00000", city: "Example" }, taxIdentifier: { scheme: "host-tax", value: "seller-a" }, registrationIds: [{ scheme: "host-registry", value: "registration-a" }], bankAccount: null, routingRef: "department-a" };
const buyer: InvoiceBuyer = { name: "Example buyer", email: null, taxIdentifier: null, companyName: null, address: { line1: null, postalCode: null, city: null, country: null } };
const line: InvoiceLine = { description: "Example item", quantity: 1, quantityUnit: "unit", unitNetMinor: 100, unitGrossMinor: 120, totalNetMinor: 100, totalTaxMinor: 20, totalGrossMinor: 120, taxRateBps: 2000, taxRateLabel: "20", positionKind: "item", catalogTotalGrossMinor: 130, discountAllocatedMinor: 10, shippingGrossMinor: null, shippingDiscountMinor: null };
export const facts: InvoiceFacts = { factRevision: "facts-a", policyVersion: "policy-a", refs: { orderId: "order-a", orderRef: "order-ref-a", invoiceRef: "invoice-a" }, dates: { issueDate: "2026-10-22", sellDate: "2026-10-22", handedOverAt: null, paymentCompletedAt: "2026-10-22T12:00:00Z" }, documentKind: "host-document", clearanceRequired: false, currency: "XXX", buyer, seller, payment: { intentRef: "intent-a", providerRef: "money-a", providerPaymentRef: null, amountMinor: 120, currency: "XXX", localSettlementState: "unavailable" }, orderMoney: { subtotalMinor: 130, discountMinor: 10, shippingMinor: 0, shippingDiscountMinor: 0, totalMinor: 120 }, lines: [line], totalNetMinor: 100, totalTaxMinor: 20, totalGrossMinor: 120, chargedTotalGrossMinor: 120 };
export const identity = { providerRef: "fiscal-a", requestKey: " exact:key ", providerCreateIdentity: "invoicing:duty-a", factRevision: facts.factRevision, orderRef: facts.refs.orderRef, invoiceRef: facts.refs.invoiceRef, operation: "issue", correctionRef: null, parentProviderDocumentRef: null } as const satisfies InvoiceIdentity;
export const proof = { evidenceRef: "evidence-a", fingerprint: "fingerprint-a", observedAt: "2026-10-22T12:01:00Z" };

// Distribute over union arms: absent/retryable evidence must be covered too.
type RequiredKeys<T> = T extends object ? { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T] : "$value";
type Input<M extends keyof InvoiceStorePort> = Parameters<InvoiceStorePort[M]>[0];
type InputPath<T, D extends readonly unknown[] = []> = T extends object ? {
  [K in keyof T & string]: K | (D["length"] extends 3 ? never : NonNullable<T[K]> extends readonly unknown[] ? never : `${K}.${InputPath<NonNullable<T[K]>, [...D, 0]>}`)
}[keyof T & string] : never;
type SellerSnapshot = Extract<Awaited<ReturnType<InvoiceHostPorts["seller"]["read"]>>, { kind: "found" }>;
type Source<M extends keyof InvoiceStorePort> = (Input<M> extends object ? `input.${InputPath<Input<M>>}` : "input")
  | "adapter.boundProvider" | "adapter.correctionContractV2" | "adapter.parentInvoiceId" | "adapter.correctionSourceKind"
  | `seller.read.${keyof Pick<SellerSnapshot, "seller" | "revisionRef">}`;
type InputRoot<S> = S extends "input" ? "$value" : S extends `input.${infer P}` ? P extends `${infer K}.${string}` ? K : P : never;

// The final argument accounts for required inputs consumed outside this SQL call
// (binding checks, managed translation, or a documented native no-op). It cannot
// silently omit a new required field. Typed paths also reject renamed/dropped keys.
export function sqlCall<M extends keyof InvoiceStorePort, const A extends readonly (readonly [string, ...Source<M>[]])[]>(
  method: M, fixture: string, name: string, args: A,
  local: Record<Exclude<RequiredKeys<Input<M>>, InputRoot<A[number][number]>>, string>,
) {
  return { method, fixture, name, args, local };
}

export function expectPinnedSqlOrder(fixture: string, name: string, names: readonly string[]) {
  const sql = readFileSync(new URL(`../../../../scripts/fixtures/20261022${fixture}.sql`, import.meta.url), "utf8");
  const signatures = [...sql.matchAll(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\(([^)]*)\\)`, "g"))];
  expect(signatures, name).toHaveLength(1);
  const parameters = signatures[0][1].split(",").map(parameter => ({
    name: parameter.trim().split(/\s+/)[0], optional: /\bDEFAULT\b/i.test(parameter),
  }));
  expect(names, name).toEqual(parameters.map(parameter => parameter.name));
  return parameters;
}
