import { describe, expect, it } from "vitest";
import { validateAccountingExportRecord } from "@openlup/platform/accounting";
import type {
  AccountingExportRecord,
  AccountingLedgerExportPort,
} from "@openlup/platform/accounting/contracts";
import {
  XERO_API_ORIGIN,
  XERO_OAUTH_TOKEN_URL,
  XERO_PROVIDER_KIND,
  createXeroAdapter,
  createXeroHttpClient,
} from "../server/index.js";
import {
  buildXeroExportRecord,
  FIXTURE_SENSITIVE_CANARIES,
  FIXTURE_TENANT_ID,
} from "./fixtures.js";

interface OutboxRecord {
  readonly exportKey: string;
  readonly status: "exported" | "refused" | "unknown";
  readonly externalRef?: string;
  readonly reason?: string;
  readonly diagnosticCode?: string;
  readonly attempts: number;
}

class LedgerExportOrchestrator {
  private readonly outbox = new Map<string, OutboxRecord>();
  private readonly adapters = new Map<string, AccountingLedgerExportPort>();

  mount(adapter: AccountingLedgerExportPort): void {
    this.adapters.set(adapter.capabilities.providerKind, adapter);
  }

  unmount(providerKind: string): void {
    this.adapters.delete(providerKind);
  }

  serializeOutbox(): string {
    return JSON.stringify([...this.outbox.values()]);
  }

  async dispatch(providerKind: string, record: AccountingExportRecord): Promise<OutboxRecord> {
    const adapter = this.adapters.get(providerKind);
    if (!adapter || typeof adapter.exportEntry !== "function") {
      throw new Error(`accounting_adapter_not_mounted:${providerKind}`);
    }

    const existing = this.outbox.get(record.exportKey);
    if (existing?.status === "exported") {
      return existing;
    }

    const preflightRefusal = validateAccountingExportRecord(record, adapter.capabilities);
    if (preflightRefusal) {
      const refused: OutboxRecord = {
        exportKey: record.exportKey,
        status: "refused",
        reason: preflightRefusal.reason,
        diagnosticCode: preflightRefusal.diagnosticCode,
        attempts: existing?.attempts ?? 0,
      };
      this.outbox.set(record.exportKey, refused);
      return refused;
    }

    if (
      existing?.status === "unknown" &&
      adapter.capabilities.supportsReadback &&
      adapter.readEntryByKey
    ) {
      const readback = await adapter.readEntryByKey(record.exportKey);
      if (readback.kind === "found") {
        const settled: OutboxRecord = {
          exportKey: record.exportKey,
          status: "exported",
          externalRef: readback.externalRef,
          attempts: existing.attempts + 1,
        };
        this.outbox.set(record.exportKey, settled);
        return settled;
      }
      if (readback.kind === "unknown") {
        const stillUnknown: OutboxRecord = {
          exportKey: record.exportKey,
          status: "unknown",
          reason: readback.reason,
          diagnosticCode: readback.diagnosticCode,
          attempts: existing.attempts + 1,
        };
        this.outbox.set(record.exportKey, stillUnknown);
        return stillUnknown;
      }
    }

    const result = await adapter.exportEntry(record);
    const nextAttempts = (existing?.attempts ?? 0) + 1;

    if (result.kind === "exported") {
      const exported: OutboxRecord = {
        exportKey: record.exportKey,
        status: "exported",
        externalRef: result.externalRef,
        attempts: nextAttempts,
      };
      this.outbox.set(record.exportKey, exported);
      return exported;
    }

    if (result.kind === "refused") {
      const refused: OutboxRecord = {
        exportKey: record.exportKey,
        status: "refused",
        reason: result.reason,
        diagnosticCode: result.diagnosticCode,
        attempts: nextAttempts,
      };
      this.outbox.set(record.exportKey, refused);
      return refused;
    }

    if (result.kind === "unknown") {
      const unknown: OutboxRecord = {
        exportKey: record.exportKey,
        status: "unknown",
        reason: result.reason,
        diagnosticCode: result.diagnosticCode,
        attempts: nextAttempts,
      };
      this.outbox.set(record.exportKey, unknown);
      return unknown;
    }

    const unsupported: OutboxRecord = {
      exportKey: record.exportKey,
      status: "refused",
      diagnosticCode: result.diagnosticCode,
      attempts: nextAttempts,
    };
    this.outbox.set(record.exportKey, unsupported);
    return unsupported;
  }
}

describe("recipes/accounting/xero — Stage 3 real-flow mount proof", () => {
  it("runs happy export, idempotent replay, 409 conflict readback recovery, and zero-I/O unbalanced refusal", async () => {
    let putCalls = 0;
    let getCalls = 0;
    let totalHttpCalls = 0;

    const fetchImpl: typeof fetch = async (input, init) => {
      totalHttpCalls += 1;
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();

      if (url.toString() === XERO_OAUTH_TOKEN_URL) {
        return new Response(
          JSON.stringify({
            access_token: FIXTURE_SENSITIVE_CANARIES.accessToken,
            token_type: "Bearer",
            expires_in: 1800,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (
        url.origin === XERO_API_ORIGIN &&
        url.pathname === "/api.xro/2.0/ManualJournals" &&
        method === "PUT"
      ) {
        putCalls += 1;
        const body = JSON.parse(String(init?.body)) as { Narration: string };
        if (body.Narration === "ord-xero-conflict-409") {
          return new Response(JSON.stringify({ Title: "Conflict" }), {
            status: 409,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            ManualJournals: [{ ManualJournalID: "xero_mj_101", Narration: body.Narration }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (
        url.origin === XERO_API_ORIGIN &&
        url.pathname === "/api.xro/2.0/ManualJournals" &&
        method === "GET"
      ) {
        getCalls += 1;
        return new Response(
          JSON.stringify({
            ManualJournals: [
              { ManualJournalID: "xero_mj_recovered_409", Narration: "ord-xero-conflict-409" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      throw new Error(`Unexpected HTTP call: ${method} ${url.toString()}`);
    };

    const client = createXeroHttpClient({
      tenantId: FIXTURE_TENANT_ID,
      clientId: FIXTURE_SENSITIVE_CANARIES.clientId,
      clientSecret: FIXTURE_SENSITIVE_CANARIES.clientSecret,
      refreshToken: FIXTURE_SENSITIVE_CANARIES.refreshToken,
      fetchImpl,
    });
    const adapter = createXeroAdapter({
      client,
      supportedCurrencies: ["GBP", "USD", "JPY"],
    });

    const orchestrator = new LedgerExportOrchestrator();
    orchestrator.mount(adapter);

    // 1. Happy export + idempotent replay (0 additional HTTP calls)
    const happyRecord = buildXeroExportRecord({ exportKey: "ord-xero-happy-01" });
    const happyOut = await orchestrator.dispatch(XERO_PROVIDER_KIND, happyRecord);
    expect(happyOut).toEqual({
      exportKey: "ord-xero-happy-01",
      status: "exported",
      externalRef: "xero_mj_101",
      attempts: 1,
    });
    expect(putCalls).toBe(1);

    const replayOut = await orchestrator.dispatch(XERO_PROVIDER_KIND, happyRecord);
    expect(replayOut).toEqual(happyOut);
    expect(putCalls).toBe(1);

    // 2. Ambiguous 409 conflict -> outbox records unknown -> recovery via readEntryByKey without duplicate PUT
    const conflictRecord = buildXeroExportRecord({ exportKey: "ord-xero-conflict-409" });
    const conflictStep1 = await orchestrator.dispatch(XERO_PROVIDER_KIND, conflictRecord);
    expect(conflictStep1.status).toBe("unknown");
    expect(conflictStep1.reason).toBe("ambiguous_conflict");
    expect(putCalls).toBe(2);
    expect(getCalls).toBe(0);

    const conflictStep2 = await orchestrator.dispatch(XERO_PROVIDER_KIND, conflictRecord);
    expect(conflictStep2).toEqual({
      exportKey: "ord-xero-conflict-409",
      status: "exported",
      externalRef: "xero_mj_recovered_409",
      attempts: 2,
    });
    expect(putCalls).toBe(2);
    expect(getCalls).toBe(1);

    // 3. Unbalanced entry -> zero-I/O refusal
    const httpCallsBeforeRefusal = totalHttpCalls;
    const unbalanced = buildXeroExportRecord({
      exportKey: "ord-xero-bad-1",
      lines: [
        { accountCode: "120", side: "debit", amountMinor: 1000 },
        { accountCode: "200", side: "credit", amountMinor: 850 },
      ],
    });
    const refusedOut = await orchestrator.dispatch(XERO_PROVIDER_KIND, unbalanced);
    expect(refusedOut.status).toBe("refused");
    expect(refusedOut.reason).toBe("unbalanced_entry");
    expect(totalHttpCalls).toBe(httpCallsBeforeRefusal);

    // 4. Outbox persistence never leaks credentials or tokens
    const serialized = orchestrator.serializeOutbox();
    for (const canary of Object.values(FIXTURE_SENSITIVE_CANARIES)) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("fails the export proof when the adapter is unmounted or broken (negative control)", async () => {
    const orchestrator = new LedgerExportOrchestrator();
    await expect(
      orchestrator.dispatch(XERO_PROVIDER_KIND, buildXeroExportRecord()),
    ).rejects.toThrow(`accounting_adapter_not_mounted:${XERO_PROVIDER_KIND}`);

    const client = createXeroHttpClient({
      tenantId: FIXTURE_TENANT_ID,
      clientId: FIXTURE_SENSITIVE_CANARIES.clientId,
      clientSecret: FIXTURE_SENSITIVE_CANARIES.clientSecret,
      refreshToken: FIXTURE_SENSITIVE_CANARIES.refreshToken,
      fetchImpl: async () => {
        throw new Error("should_not_run");
      },
    });
    const adapter = createXeroAdapter({ client });
    orchestrator.mount(adapter);
    orchestrator.unmount(XERO_PROVIDER_KIND);

    await expect(
      orchestrator.dispatch(XERO_PROVIDER_KIND, buildXeroExportRecord()),
    ).rejects.toThrow(`accounting_adapter_not_mounted:${XERO_PROVIDER_KIND}`);

    orchestrator.mount({
      capabilities: adapter.capabilities,
    } as unknown as AccountingLedgerExportPort);

    await expect(
      orchestrator.dispatch(XERO_PROVIDER_KIND, buildXeroExportRecord()),
    ).rejects.toThrow(`accounting_adapter_not_mounted:${XERO_PROVIDER_KIND}`);
  });
});
