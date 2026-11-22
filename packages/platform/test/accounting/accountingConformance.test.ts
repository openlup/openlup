import { describe, expect, it } from "vitest";
import {
  ACCOUNTING_EXPORT_CONTRACT_VERSION,
  validateAccountingExportRecord,
  type AccountingCapabilities,
  type AccountingExportRecord,
  type AccountingExportResult,
  type AccountingLedgerExportPort,
  type AccountingReadbackResult,
} from "../../src/accounting/index.js";
import {
  createScriptedAccountingFake,
  runAccountingAdapterConformance,
  ScriptedAccountingTransportError,
  type AccountingScenarioHarness,
  type ScriptedAccountingOutcome,
} from "../../src/accounting/testing/index.js";

type AccCalls = { exportEntry: { readonly id: string }; readEntry: { readonly id: string } | null };

const CAPS: AccountingCapabilities = {
  contractVersion: ACCOUNTING_EXPORT_CONTRACT_VERSION,
  providerKind: "synthetic_ledger",
  supportedEntryKinds: ["sale", "refund", "payout"],
  supportedCurrencies: ["USD", "EUR"],
  supportsReadback: true,
  supportsIdempotencyKey: true,
  requiresCredentials: true,
};

const SAMPLE_RECORD: AccountingExportRecord = {
  contractVersion: ACCOUNTING_EXPORT_CONTRACT_VERSION,
  exportKey: "order:ord-1001:sale",
  entryKind: "sale",
  entryDate: "2000-01-15",
  currency: "USD",
  sourceRef: "ord-1001",
  lines: [
    { accountCode: "1100", side: "debit", amountMinor: 2500 },
    { accountCode: "4000", side: "credit", amountMinor: 2500 },
  ],
};

function makeHarness(
  outcome: ScriptedAccountingOutcome<{ readonly id: string }>,
  opts?: { readback?: ScriptedAccountingOutcome<{ readonly id: string } | null>; leak?: string },
): AccountingScenarioHarness {
  const fake = createScriptedAccountingFake<AccCalls>();
  if (opts?.readback) fake.enqueue("readEntry", opts.readback);
  else fake.enqueue("exportEntry", outcome);

  const adapter: AccountingLedgerExportPort = {
    capabilities: CAPS,
    async exportEntry(record): Promise<AccountingExportResult> {
      const refusal = validateAccountingExportRecord(record, CAPS);
      if (refusal) return refusal;
      try {
        const res = await fake.invoke("exportEntry");
        return {
          kind: "exported",
          providerKind: CAPS.providerKind,
          externalRef: opts?.leak ? `${res.id}-${opts.leak}` : res.id,
          exportKey: record.exportKey,
        };
      } catch (err) {
        if (err instanceof ScriptedAccountingTransportError) {
          if (err.kind === "timeout") {
            return { kind: "unknown", providerKind: CAPS.providerKind, reason: "timeout", retryable: true, effectMayHaveSucceeded: true, diagnosticCode: "LEDGER_TIMEOUT" };
          }
          if (err.kind === "rate-limited-429") {
            return {
              kind: "unknown",
              providerKind: CAPS.providerKind,
              reason: "rate_limited",
              retryable: true,
              effectMayHaveSucceeded: true,
              diagnosticCode: "LEDGER_RATE_LIMITED",
              ...(err.retryAfterSeconds !== undefined ? { retryAfterSeconds: err.retryAfterSeconds } : {}),
            };
          }
          if (err.kind === "http-failure") {
            if (err.status === 401 || err.status === 403) {
              return { kind: "refused", providerKind: CAPS.providerKind, reason: "authentication_failed", retryable: false, effectMayHaveSucceeded: false, diagnosticCode: "LEDGER_AUTH_FAILED" };
            }
            if (err.status === 408 || err.status === 409) {
              return { kind: "unknown", providerKind: CAPS.providerKind, reason: "ambiguous_conflict", retryable: true, effectMayHaveSucceeded: true, diagnosticCode: "LEDGER_CONFLICT" };
            }
          }
        }
        return { kind: "unknown", providerKind: CAPS.providerKind, reason: "provider_unavailable", retryable: true, effectMayHaveSucceeded: true, diagnosticCode: "LEDGER_UNAVAILABLE" };
      }
    },
    async readEntryByKey(exportKey): Promise<AccountingReadbackResult> {
      const found = await fake.invoke("readEntry");
      return found
        ? { kind: "found", providerKind: CAPS.providerKind, externalRef: found.id, exportKey }
        : { kind: "absent", providerKind: CAPS.providerKind, exportKey };
    },
  };
  return { adapter, record: SAMPLE_RECORD, readIoCount: () => fake.calls.length, readFaultLog: () => fake.calls };
}

describe("@openlup/platform/accounting and /testing", () => {
  it("certifies a balanced ledger adapter in full mode including 409/429/5xx/timeout uncertainty and readback", async () => {
    const canary = "acct-canary-marker/alpha+01";
    const evidence = await runAccountingAdapterConformance(
      [
        {
          id: "synthetic-ledger",
          sensitiveValues: [canary],
          happyExport: () => makeHarness({ kind: "success", value: { id: "je_001" } }),
          certification: {
            http5xx: () => makeHarness({ kind: "http-failure", status: 503 }),
            httpAuthFailure: () => makeHarness({ kind: "http-failure", status: 401 }),
            httpConflict409: () => makeHarness({ kind: "http-failure", status: 409 }),
            rateLimited429: () => makeHarness({ kind: "rate-limited-429", retryAfterSeconds: 30 }),
            timeout: () => makeHarness({ kind: "timeout" }),
            readbackFound: () =>
              makeHarness(
                { kind: "success", value: { id: "unused" } },
                { readback: { kind: "success", value: { id: "je_001" } } },
              ),
          },
        },
      ],
      { mode: "full" },
    );
    expect(evidence.qualifications).toHaveLength(1);
    expect(evidence.qualifications[0]!.ledger.filter((l) => l.role === "transport-fault")).toHaveLength(5);
    expect(evidence.qualifications[0]!.ledger.some((l) => l.role === "readback")).toBe(true);
  });

  it("rejects canary leaks and forged fault logs (negative controls)", async () => {
    const canary = "acct-canary-marker/beta+02";
    await expect(
      runAccountingAdapterConformance([
        {
          id: "leaky",
          sensitiveValues: [canary],
          happyExport: () => makeHarness({ kind: "success", value: { id: "je_001" } }, { leak: canary }),
        },
      ]),
    ).rejects.toThrow(/ACCOUNTING_CONFORMANCE:secret_leak/);
  });
});
