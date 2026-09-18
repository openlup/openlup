import { describe, expect, it, vi } from "vitest";
import { AccountingInvoicePersistenceError } from "../../../src/domains/accounting/ports.js";
import {
  accountingInvoiceReason,
  permanentInvoiceRefusal,
  requestAccountingInvoice,
} from "./omnipackReconciliationInvoice.js";
import type { OmnipackReconciliationPort, OmnipackReconciliationResult } from "./omnipackReconciliationContracts.js";

const PERSISTENCE_MESSAGE = "Accounting invoice issue request failed";

// The four identifiers are asserted BY VALUE against the outbox twin
// (server/domains/accounting/fulfillmentHandoffInvoiceHandler.ts:45-50): they are
// the 22023 raises meaning a row was legitimately deleted. Everything else that
// the RPC refuses is an anomaly, so the split cannot be widened without editing
// this list. Mutation check (criterion 14): deleting the SQLSTATE comparison in
// permanentInvoiceRefusal turns the refusal cases below red.
const BENIGN_IDENTIFIERS = [
  "accounting_invoice_handoff_not_found",
  "accounting_invoice_order_not_found",
  "accounting_invoice_client_not_found",
  "accounting_invoice_address_not_found",
];

describe("OmniPack reconciliation accounting invoice refusal", () => {
  it("classifies the refund refusal as a permanent anomalous refusal", () => {
    expect(permanentInvoiceRefusal(persistenceError("22023", "accounting_invoice_payment_not_succeeded")))
      .toEqual({ identifier: "accounting_invoice_payment_not_succeeded", sqlstate: "22023", benign: false });
  });

  it.each(BENIGN_IDENTIFIERS)("classifies the deleted-row refusal %s as benign", (identifier) => {
    expect(permanentInvoiceRefusal(persistenceError("22023", identifier)))
      .toEqual({ identifier, sqlstate: "22023", benign: true });
  });

  it.each([
    "accounting_invoice_handoff_requires_package_shipped",
    "accounting_invoice_handoff_invalid_input",
  ])("keeps the other permanent refusal %s anomalous", (identifier) => {
    expect(permanentInvoiceRefusal(persistenceError("22023", identifier))?.benign).toBe(false);
  });

  // Deliberate divergence from the outbox twin's permanent set. 23514 is the
  // provider-immutability check: it re-fires for every invoiced order in every
  // run whenever the runtime asks for a different provider than the invoice was
  // created with, so it is a fleet-wide configuration fault rather than one
  // fulfilment's fact and must stay a loud run failure. Mutation check
  // (criterion 14): adding 23514 back to the permanent set turns this red.
  it.each([
    { name: "the provider-immutability check", code: "23514", identifier: "accounting_invoice_provider_mismatch" },
    { name: "a serialization failure", code: "40001", identifier: undefined },
  ])("does not classify $name as a per-fulfilment refusal", ({ code, identifier }) => {
    expect(permanentInvoiceRefusal(persistenceError(code, identifier))).toBeNull();
  });

  it.each([
    { name: "a plain error", error: new Error("invoice_request_unavailable") },
    { name: "a thrown string", error: "invoice_request_unavailable" },
    { name: "a refusal with no SQLSTATE", error: persistenceError(undefined, "accounting_invoice_handoff_not_found") },
    { name: "null", error: null },
  ])("does not classify $name as a refusal", ({ error }) => {
    expect(permanentInvoiceRefusal(error)).toBeNull();
  });

  it("keeps a null identifier when the refusal carries no raise message", () => {
    expect(permanentInvoiceRefusal(persistenceError("22023", undefined)))
      .toEqual({ identifier: null, sqlstate: "22023", benign: false });
  });
});

describe("OmniPack reconciliation accounting invoice reason", () => {
  it("names the raise identifier and the SQLSTATE", () => {
    expect(accountingInvoiceReason(persistenceError("22023", "accounting_invoice_payment_not_succeeded")))
      .toBe(`${PERSISTENCE_MESSAGE}: accounting_invoice_payment_not_succeeded (22023)`);
  });

  it("names an unclassified failure the same way, so the ledger says which guard refused", () => {
    expect(accountingInvoiceReason(persistenceError("23514", "accounting_invoice_provider_mismatch")))
      .toBe(`${PERSISTENCE_MESSAGE}: accounting_invoice_provider_mismatch (23514)`);
  });

  // omnipackReconciliationWorker.test.ts pins the exact reason a plain Error
  // produces. Appending anything here, or rewording the prefix in
  // requestAccountingInvoice, turns that assertion red.
  it("falls back to the shared safe reason for an error with no refusal identity", () => {
    expect(accountingInvoiceReason(new Error("invoice_request_unavailable"))).toBe("invoice_request_unavailable");
    expect(accountingInvoiceReason("invoice_request_unavailable")).toBe("invoice_request_unavailable");
  });

  it("does not repeat the message when the raise identifier is the message", () => {
    expect(accountingInvoiceReason(new AccountingInvoicePersistenceError("boom", "22023", "boom")))
      .toBe("boom (22023)");
  });

  it("caps the reason at 300 characters", () => {
    const reason = accountingInvoiceReason(
      new AccountingInvoicePersistenceError("x".repeat(400), "22023", "y".repeat(400)),
    );
    expect(reason).toHaveLength(300);
    expect(reason.startsWith("x".repeat(180))).toBe(true);
  });
});

describe("OmniPack reconciliation accounting invoice request", () => {
  it("itemises at most ten refusals while the counter keeps counting", async () => {
    const port = invoicePort(persistenceError("22023", "accounting_invoice_payment_not_succeeded"));
    const result = emptyResult();

    for (let index = 0; index < 11; index += 1) {
      await requestAccountingInvoice(port, `ful-${index}`, result);
    }

    expect(result).toMatchObject({ ok: true, failures: 0, invoiceIssueFailures: 0, invoiceIssueRefused: 11 });
    expect(result.invoiceIssueRefusals).toHaveLength(10);
    expect(result.invoiceIssueRefusals.at(-1)?.fulfillmentOrderId).toBe("ful-9");
    // A refusal carries its own reason prefix. An operator reading
    // platform_job_runs must not have to guess whether a recorded reason means
    // one fulfilment refused permanently or the run itself faulted, so the two
    // branches never share a prefix.
    expect(result.reason).toBe(
      "omnipack_reconciliation_accounting_invoice_issue_refused:"
      + `${PERSISTENCE_MESSAGE}: accounting_invoice_payment_not_succeeded (22023)`,
    );
  });

  it("keeps the failure prefix for anything the classifier does not call a refusal", async () => {
    const result = emptyResult();

    await requestAccountingInvoice(invoicePort(new Error("invoice_request_unavailable")), "ful-1", result);

    expect(result).toMatchObject({
      ok: false,
      failures: 1,
      invoiceIssueFailures: 1,
      invoiceIssueRefused: 0,
      reason: "omnipack_reconciliation_accounting_invoice_issue_failed:invoice_request_unavailable",
    });
  });

  it("keeps the first reason so a real failure elsewhere on the page still wins the slot", async () => {
    const result = { ...emptyResult(), reason: "omnipack_reconciliation_dispatch_acknowledgement_failed:08006" };

    await requestAccountingInvoice(
      invoicePort(persistenceError("22023", "accounting_invoice_payment_not_succeeded")),
      "ful-1",
      result,
    );

    expect(result.reason).toBe("omnipack_reconciliation_dispatch_acknowledgement_failed:08006");
    expect(result.invoiceIssueRefused).toBe(1);
  });
});

function persistenceError(causeCode?: string, causeMessage?: string): AccountingInvoicePersistenceError {
  return new AccountingInvoicePersistenceError(PERSISTENCE_MESSAGE, causeCode, causeMessage);
}

function invoicePort(error: unknown): OmnipackReconciliationPort {
  return {
    issueAccountingInvoice: vi.fn(async () => { throw error; }),
  } as unknown as OmnipackReconciliationPort;
}

function emptyResult(): OmnipackReconciliationResult {
  return {
    ok: true,
    checked: 0,
    updated: 0,
    trackingRefs: 0,
    quarantined: 0,
    stateConflicts: 0,
    exceptions: 0,
    stale: 0,
    offTrackSkips: 0,
    replayed: 0,
    failures: 0,
    invoiceIssueFailures: 0,
    invoiceIssueRefused: 0,
    invoiceIssueRefusals: [],
    providerCalls: 0,
    readBacks: 0,
    skipped: false,
  };
}
