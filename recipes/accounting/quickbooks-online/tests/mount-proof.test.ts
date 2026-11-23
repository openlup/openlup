import { describe, expect, it } from "vitest";
import { validateAccountingExportRecord } from "@openlup/platform/accounting";
import type {
  AccountingExportRecord,
  AccountingLedgerExportPort,
} from "@openlup/platform/accounting/contracts";
import {
  QBO_OAUTH_TOKEN_URL,
  QBO_ORIGINS,
  QBO_PROVIDER_KIND,
  createQuickBooksOnlineAdapter,
  createQuickBooksOnlineHttpClient,
} from "../server/index.js";
import {
  buildQuickBooksExportRecord,
  FIXTURE_REALM_ID,
  FIXTURE_SENSITIVE_CANARIES,
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

  readOutbox(exportKey: string): OutboxRecord | undefined {
    return this.outbox.get(exportKey);
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

    // When recovering from an ambiguous outcome, verify provider state via readEntryByKey first.
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

describe("recipes/accounting/quickbooks-online — Stage 3 real-flow mount proof", () => {
  it("runs happy export, idempotent replay, 409 conflict readback recovery, and zero-I/O unbalanced refusal", async () => {
    let postCalls = 0;
    let getCalls = 0;
    let totalHttpCalls = 0;
    const postedPayloads: unknown[] = [];

    const fetchImpl: typeof fetch = async (input, init) => {
      totalHttpCalls += 1;
      const url = new URL(String(input));

      if (url.toString() === QBO_OAUTH_TOKEN_URL) {
        return new Response(
          JSON.stringify({
            access_token: FIXTURE_SENSITIVE_CANARIES.accessToken,
            token_type: "bearer",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (
        url.origin === QBO_ORIGINS.sandbox &&
        url.pathname === `/v3/company/${FIXTURE_REALM_ID}/journalentry`
      ) {
        postCalls += 1;
        const body = JSON.parse(String(init?.body)) as { DocNumber: string };
        postedPayloads.push(body);
        if (body.DocNumber === "ord-conflict-409") {
          return new Response(JSON.stringify({ Fault: { type: "ConcurrentConflict" } }), {
            status: 409,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            JournalEntry: { Id: "qbo_mount_101", DocNumber: body.DocNumber },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (
        url.origin === QBO_ORIGINS.sandbox &&
        url.pathname === `/v3/company/${FIXTURE_REALM_ID}/query`
      ) {
        getCalls += 1;
        return new Response(
          JSON.stringify({
            QueryResponse: {
              JournalEntry: [{ Id: "qbo_recovered_409", DocNumber: "ord-conflict-409" }],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      throw new Error(`Unexpected HTTP call: ${url.toString()}`);
    };

    const client = createQuickBooksOnlineHttpClient({
      environment: "sandbox",
      realmId: FIXTURE_REALM_ID,
      clientId: FIXTURE_SENSITIVE_CANARIES.clientId,
      clientSecret: FIXTURE_SENSITIVE_CANARIES.clientSecret,
      refreshToken: FIXTURE_SENSITIVE_CANARIES.refreshToken,
      fetchImpl,
    });
    const adapter = createQuickBooksOnlineAdapter({
      client,
      supportedCurrencies: ["USD", "JPY"],
    });

    const orchestrator = new LedgerExportOrchestrator();
    orchestrator.mount(adapter);

    // 1. Happy export + idempotent replay (0 additional HTTP calls)
    const happyRecord = buildQuickBooksExportRecord({ exportKey: "ord-happy-01" });
    const happyOut = await orchestrator.dispatch(QBO_PROVIDER_KIND, happyRecord);
    expect(happyOut).toEqual({
      exportKey: "ord-happy-01",
      status: "exported",
      externalRef: "qbo_mount_101",
      attempts: 1,
    });
    expect(postCalls).toBe(1);

    const replayOut = await orchestrator.dispatch(QBO_PROVIDER_KIND, happyRecord);
    expect(replayOut).toEqual(happyOut);
    expect(postCalls).toBe(1);

    // 2. Ambiguous 409 conflict -> outbox records unknown -> recovery via readEntryByKey without duplicate POST
    const conflictRecord = buildQuickBooksExportRecord({ exportKey: "ord-conflict-409" });
    const conflictStep1 = await orchestrator.dispatch(QBO_PROVIDER_KIND, conflictRecord);
    expect(conflictStep1.status).toBe("unknown");
    expect(conflictStep1.reason).toBe("ambiguous_conflict");
    expect(postCalls).toBe(2);
    expect(getCalls).toBe(0);

    const conflictStep2 = await orchestrator.dispatch(QBO_PROVIDER_KIND, conflictRecord);
    expect(conflictStep2).toEqual({
      exportKey: "ord-conflict-409",
      status: "exported",
      externalRef: "qbo_recovered_409",
      attempts: 2,
    });
    expect(postCalls).toBe(2);
    expect(getCalls).toBe(1);

    // 3. Unbalanced entry -> zero-I/O refusal
    const httpCallsBeforeRefusal = totalHttpCalls;
    const unbalanced = buildQuickBooksExportRecord({
      exportKey: "ord-bad-1",
      lines: [
        { accountCode: "1100", side: "debit", amountMinor: 1000 },
        { accountCode: "4000", side: "credit", amountMinor: 900 },
      ],
    });
    const refusedOut = await orchestrator.dispatch(QBO_PROVIDER_KIND, unbalanced);
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
      orchestrator.dispatch(QBO_PROVIDER_KIND, buildQuickBooksExportRecord()),
    ).rejects.toThrow(`accounting_adapter_not_mounted:${QBO_PROVIDER_KIND}`);

    const client = createQuickBooksOnlineHttpClient({
      environment: "sandbox",
      realmId: FIXTURE_REALM_ID,
      clientId: FIXTURE_SENSITIVE_CANARIES.clientId,
      clientSecret: FIXTURE_SENSITIVE_CANARIES.clientSecret,
      refreshToken: FIXTURE_SENSITIVE_CANARIES.refreshToken,
      fetchImpl: async () => {
        throw new Error("should_not_run");
      },
    });
    const adapter = createQuickBooksOnlineAdapter({ client });
    orchestrator.mount(adapter);
    orchestrator.unmount(QBO_PROVIDER_KIND);

    await expect(
      orchestrator.dispatch(QBO_PROVIDER_KIND, buildQuickBooksExportRecord()),
    ).rejects.toThrow(`accounting_adapter_not_mounted:${QBO_PROVIDER_KIND}`);

    // Broken adapter without exportEntry also fails mount proof.
    orchestrator.mount({
      capabilities: adapter.capabilities,
    } as unknown as AccountingLedgerExportPort);

    await expect(
      orchestrator.dispatch(QBO_PROVIDER_KIND, buildQuickBooksExportRecord()),
    ).rejects.toThrow(`accounting_adapter_not_mounted:${QBO_PROVIDER_KIND}`);
  });
});
