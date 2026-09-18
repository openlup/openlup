import assert from "node:assert/strict";
import pg from "pg";
import { createPostgresDataGateway } from "../../server/adapters/postgres/dataGateway.js";
import type { TpayHttpClient } from "../../server/infra/tpay/tpayHttpClient.js";
import type { TpayTransactionCreateInput } from "../../server/infra/tpay/tpayTransactionPayload.js";
import type { NormalizedProviderPaymentWebhook } from "../../server/domains/payment/paymentWebhookHandlers.js";
import {
  createPaymentWebhookControlPortViaGateway,
  createTpayActivationAfterProcessedViaGateway,
  createTpayPaymentWebhookMethodRefPortViaGateway,
} from "../../server/adapters/supabase/payment/paymentWebhookGateway.js";
import { consumeSupabasePaymentMethodDelivery } from "../../server/adapters/supabase/payment/paymentMethodLifecycle.js";

type DataGateway = ReturnType<typeof createPostgresDataGateway>;

/** Shared rehearsal context — explicit deps so module imports stay side-effect-free. */
export type RehearsalHarness = {
  sql: pg.Client;
  gateway: DataGateway;
  run: string;
  serviceRow: <T extends Record<string, unknown>>(query: string, params?: unknown[]) => Promise<T>;
  deliverWebhook: (event: NormalizedProviderPaymentWebhook) => Promise<{ paymentEventId: string }>;
};

export function tpayEvent(overrides: Partial<NormalizedProviderPaymentWebhook>): NormalizedProviderPaymentWebhook {
  return {
    provider: "tpay",
    providerEventId: "missing",
    eventType: "payment.succeeded",
    providerPaymentId: "missing",
    occurredAt: new Date().toISOString(),
    rawPayload: {},
    ...overrides,
  };
}

export function capturingTpayClient(run: string): { client: TpayHttpClient; calls: TpayTransactionCreateInput[] } {
  const calls: TpayTransactionCreateInput[] = [];
  const client: TpayHttpClient = {
    async createTransaction(input) {
      calls.push(input);
      return {
        transactionId: `01REH${run}${calls.length}`,
        title: `TR-REH-${run}-${calls.length}`,
        status: "pending",
        transactionPaymentUrl: "https://secure.sandbox.tpay.com/tx",
        requestId: `req-reh-${calls.length}`,
        payIdEligible: null,
        errors: [],
      };
    },
    async getTransaction() {
      throw new Error("rehearsal never reads transactions back");
    },
    async listPaymentChannels() {
      return [];
    },
  };
  return { client, calls };
}

// Connect the raw pg client, build the via-gateway ports, and return the shared
// context. Called from the entry after the localhost guard — importing this
// module runs nothing.
export async function createHarness(dbUrl: string, run: string): Promise<RehearsalHarness> {
  const { Client } = pg;
  const sql = new Client({ connectionString: dbUrl });
  await sql.connect();

  const gateway = createPostgresDataGateway({ connectionString: dbUrl });
  const controlPort = createPaymentWebhookControlPortViaGateway(gateway);
  const methodRefPort = createTpayPaymentWebhookMethodRefPortViaGateway(
    gateway,
    consumeSupabasePaymentMethodDelivery,
  );
  const afterProcessed = createTpayActivationAfterProcessedViaGateway(gateway);

  async function serviceRow<T extends Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T> {
    await sql.query("BEGIN");
    await sql.query("SET LOCAL ROLE service_role");
    try {
      const { rows } = await sql.query<T>(query, params);
      await sql.query("COMMIT");
      assert.ok(rows[0], `query must return a row: ${query.slice(0, 60)}`);
      return rows[0];
    } catch (error) {
      await sql.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  /** Mirrors the shared webhook handler order: ingest → apply (money) → method refs → activation → setup-ledger close. */
  async function deliverWebhook(event: NormalizedProviderPaymentWebhook): Promise<{ paymentEventId: string }> {
    const ingested = await controlPort.ingestPaymentEvent(event);
    const resultStatus = event.eventType === "payment.succeeded" ? ("succeeded" as const) : null;
    if (resultStatus && ingested.paymentIntentId) {
      assert.ok(controlPort.applyPaymentResult, "control port must expose applyPaymentResult");
      await controlPort.applyPaymentResult({
        idempotencyKey: `provider-webhook:tpay:${event.providerEventId}:apply`,
        paymentIntentId: ingested.paymentIntentId,
        paymentEventId: ingested.paymentEventId,
        resultStatus,
        occurredAt: event.occurredAt,
        failureReason: null,
      });
    }
    await methodRefPort.upsertFromWebhook(event);
    await afterProcessed({ event, ingested, resultStatus });
    if (resultStatus === null && event.eventType.startsWith("setup.")) {
      assert.ok(controlPort.markSetupEventProcessed, "control port must expose markSetupEventProcessed");
      await controlPort.markSetupEventProcessed({ paymentEventId: ingested.paymentEventId });
    }
    return { paymentEventId: ingested.paymentEventId };
  }

  return { sql, gateway, run, serviceRow, deliverWebhook };
}
