import { describe, expect, it } from "vitest";

import { readCommerceServiceDataGateway } from "../../server/bff/commerce/serviceDataGateway.js";
import {
  createManagedPaymentControlRuntimePort as createRuntimePort,
} from "../../server/adapters/managed/commerce/paymentControlRuntimePort.js";
import {
  createPaymentWebhookControlPortViaGateway as createEventPort,
} from "../../server/adapters/supabase/payment/paymentWebhookGateway.js";
import {
  runDurableEventConformance,
  type DurableEventAggregate,
  type DurableEventCapability,
  type DurableEventCardinalityExpectations,
  type DurableEventSnapshot,
} from "../../server/domains/payment/eventConformanceRunner.js";
import {
  LOCAL_REFERENCE_CONCRETE_PAYMENT_PROVIDER as PAYMENT_PROVIDER,
} from "../../server/adapters/localReferenceCompositionIdentity.js";

const NAMESPACE = "reference-cp1p-payment-events-v1";
const EMAIL = `${NAMESPACE}-primary@example.test`;
const CLIENT_ID = "c1f10000-0000-4000-8000-000000000001";
const ORDER_IDS = {
  outOfOrder: "c1f20000-0000-4000-8000-000000000001",
  lateSuccess: "c1f20000-0000-4000-8000-000000000002",
} as const;
const EVENT_KEYS = ["a-success", "a-failure", "b-failure", "b-success"];
const AMOUNT_MINOR = 12_999;
const SERVICE_ROLE_SUFFIX = "_SERVICE_ROLE_KEY";
const LOCAL_ENABLED = process.env.CP1P_LOCAL_DATABASE === "1";
const localIt = LOCAL_ENABLED ? it : it.skip;

// Exact durable write cardinality of THIS adapter, asserted at the exact step the
// shared runner reaches it. The numbers describe this repository's payment-control
// writer and its outbox fan-out, so they belong to the collector that owns the
// adapter, not to the portable contract: a second runtime bundle proves the same
// behaviour with its own counts. Values are unchanged from the runner they moved
// out of (0/4/4/2 -> 1/5/5/4 -> 2/6/6/4 -> duplicate unchanged -> 3/7/7/5 -> 4/8/8/7).
const CARDINALITY: DurableEventCardinalityExpectations = {
  fixture: { clients: 1, orders: 2, payments: 2, intents: 2, attempts: 2 },
  baseline: { events: 0, transitions: 4, idempotencyKeys: 4, outboxEvents: 2 },
  afterOutOfOrderSuccess: { events: 1, transitions: 5, idempotencyKeys: 5, outboxEvents: 4 },
  afterOutOfOrderFailure: { events: 2, transitions: 6, idempotencyKeys: 6, outboxEvents: 4 },
  afterDuplicate: { events: 2, transitions: 6, idempotencyKeys: 6, outboxEvents: 4 },
  afterLateFailure: { events: 3, transitions: 7, idempotencyKeys: 7, outboxEvents: 5 },
  final: { events: 4, transitions: 8, idempotencyKeys: 8, outboxEvents: 7 },
};

type QueryResult = { data: unknown; error: { message?: string } | null };
type Query = PromiseLike<QueryResult> & {
  select(...args: unknown[]): Query; insert(value: unknown): Query; delete(): Query;
  update(value: unknown): Query; eq(column: string, value: unknown): Query;
  in(column: string, values: string[]): Query; like(column: string, value: string): Query;
};
type TestClient = Parameters<typeof createRuntimePort>[0] & { from(table: string): Query };
type ServiceGateway = NonNullable<ReturnType<typeof readCommerceServiceDataGateway>>;
type EnvLike = Record<string, string | undefined>;
type AggregateKey = keyof typeof ORDER_IDS;
type Row = Record<string, unknown>;

describe("payment event port conformance: local database events", () => {
  it("refuses hosted markers before client creation without treating region as hosted", async () => {
    let clientConstructed = false;
    const gatewayFactory = () => {
      clientConstructed = true;
      return null;
    };
    await expect(createLocalSubject({}, gatewayFactory, "https://db.example.test")).rejects.toThrow(/loopback database URL/);
    expect(clientConstructed).toBe(false);
    await expect(createLocalSubject({ DEPLOY_ENV: "preview" }, gatewayFactory, "http://127.0.0.1:54321")).rejects.toThrow(/hosted environments/);
    expect(clientConstructed).toBe(false);
    await expect(createLocalSubject({ S3_PROTOCOL_REGION: "eu-central-1" }, gatewayFactory, "http://127.0.0.1:54321")).rejects.toThrow(/gateway is required/);
    expect(clientConstructed).toBe(true);
  });

  localIt("proves durable duplicate, ordering, late-success, and cleanup behavior", async () => {
    const endpoint = readDataGatewayEndpoint(process.env);
    if (!endpoint) throw new Error("Local database connection is required");
    const evidence = await withLocalEndpointEnvironment(endpoint, async (localEnv) => {
      const subject = await createLocalSubject(localEnv, undefined, endpoint);
      return runDurableEventConformance(subject, CARDINALITY);
    });

    expect(evidence.capability).toEqual({ name: "database-events", durabilityClaim: true });
    expect(evidence.cleanupResidualRows).toBe(0);
    expect(evidence.final.counts).toEqual({
      clients: 1,
      orders: 2,
      payments: 2,
      intents: 2,
      attempts: 2,
      events: 4,
      transitions: 8,
      idempotencyKeys: 8,
      outboxEvents: 7,
    });
    process.stdout.write(`CP1-P durable evidence ${JSON.stringify({
      baseline: evidence.baseline.counts,
      afterOutOfOrderSuccess: evidence.afterOutOfOrderSuccess.counts,
      afterOutOfOrderFailure: evidence.afterOutOfOrderFailure.counts,
      afterDuplicate: evidence.afterDuplicate.counts,
      afterLateFailure: evidence.afterLateFailure.counts,
      final: evidence.final.counts,
      aggregates: evidence.final.aggregates,
      events: evidence.final.events,
      cleanupResidualRows: evidence.cleanupResidualRows,
    })}\n`);
  });
});

async function withLocalEndpointEnvironment<T>(
  url: string,
  run: (env: EnvLike) => Promise<T>,
): Promise<T> {
  const previous = dataGatewayEndpointEntries(process.env).filter(([key, value]) =>
    !/(?:DATABASE_URL|DB_URL)$/i.test(key) && /^https?:/i.test(value),
  );
  for (const [key] of previous) process.env[key] = url;
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = { value: await run(process.env) };
  } catch (error) {
    outcome = { error };
  } finally {
    for (const [key, value] of previous) process.env[key] = value;
  }
  for (const [key, value] of previous) {
    if (process.env[key] !== value) throw new Error(`Failed to restore endpoint ${key}`);
  }
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

async function createLocalSubject(
  env: EnvLike,
  gatewayFactory: () => ServiceGateway | null = readCommerceServiceDataGateway,
  endpoint: string | null = readDataGatewayEndpoint(env),
): Promise<LocalDatabaseEventSubject> {
  if (!endpoint) throw new Error("Local database connection is required");
  const assertSafe = () => assertLocalDatabase(env, endpoint);
  assertSafe();
  const gateway = gatewayFactory();
  if (!gateway) throw new Error("Local database gateway is required");
  const client = await gateway.asService(async (value) => value as TestClient);
  return new LocalDatabaseEventSubject(client, gateway, assertSafe);
}

class LocalDatabaseEventSubject implements DurableEventCapability {
  readonly name = "database-events";
  readonly durabilityClaim = true;
  private readonly runtime;
  private readonly webhook;
  private readonly paymentIds = new Set<string>();
  private readonly intentIds = new Set<string>();
  private readonly attemptIds = new Set<string>();
  private readonly eventIds = new Set<string>();
  private readonly outboxIds = new Set<string>();
  private aggregates: Record<AggregateKey, Pick<
    DurableEventAggregate,
    "orderId" | "paymentId" | "paymentIntentId" | "paymentAttemptId"
  >> | null = null;

  constructor(
    private readonly client: TestClient,
    gateway: ServiceGateway,
    private readonly safety: () => void,
  ) {
    this.runtime = createRuntimePort(client);
    this.webhook = createEventPort(gateway);
  }

  assertSafe(): void {
    this.safety();
  }

  async reset(): Promise<{ residualRows: number }> {
    await this.discoverOwnedIds();
    await this.cleanupOwnedRows();
    const residualRows = await this.residualRows();
    this.aggregates = null;
    return { residualRows };
  }

  async seed(): Promise<void> {
    await requireSuccess(
      this.client.from("clients").insert({
        id: CLIENT_ID,
        email: EMAIL,
        first_name: "Conformance",
        last_name: "Fixture",
        metadata: { source: NAMESPACE },
      }),
      "seed client",
    );
    await requireSuccess(
      this.client.from("commerce_orders").insert(Object.values(ORDER_IDS).map((id) => ({
        id,
        client_id: CLIENT_ID,
        currency: "PLN",
        region_code: "PL",
        size_constraint: { kind: "feeding_days", value: 28 },
        status: "draft",
        total_cents: AMOUNT_MINOR,
        subtotal_cents: AMOUNT_MINOR,
        mode: "one_time",
        metadata: { source: NAMESPACE },
      }))),
      "seed orders",
    );

    const aggregates = {} as NonNullable<typeof this.aggregates>;
    for (const aggregate of Object.keys(ORDER_IDS) as AggregateKey[]) {
      const orderId = ORDER_IDS[aggregate];
      const intent = await this.runtime.createIntent({
        idempotencyKey: `${NAMESPACE}:intent:${aggregate}`,
        targetKind: "one_time_order",
        orderId,
        subscriptionId: null,
        subscriptionCycleId: null,
        amountMinor: AMOUNT_MINOR,
        currency: "PLN",
        metadata: { source: NAMESPACE },
      });
      const attempt = await this.runtime.recordAttempt({
        idempotencyKey: `${NAMESPACE}:attempt:${aggregate}`,
        paymentIntentId: intent.paymentIntentId,
        provider: PAYMENT_PROVIDER,
        providerAttemptId: `${NAMESPACE}:${aggregate}`,
        providerSessionId: null,
        attemptStatus: "processing",
        nextActionKind: null,
        requestPayload: { source: NAMESPACE },
        responsePayload: { providerCall: false },
      });
      this.paymentIds.add(intent.paymentId);
      this.intentIds.add(intent.paymentIntentId);
      this.attemptIds.add(attempt.paymentAttemptId);
      aggregates[aggregate] = {
        orderId,
        paymentId: intent.paymentId,
        paymentIntentId: intent.paymentIntentId,
        paymentAttemptId: attempt.paymentAttemptId,
      };
    }
    this.aggregates = aggregates;
  }

  async ingest(input: {
    aggregate: AggregateKey;
    eventKey: string;
    resultStatus: "succeeded" | "failed";
    occurredAt: string;
  }) {
    const aggregate = this.aggregate(input.aggregate);
    const receipt = await this.webhook.ingestPaymentEvent({
      provider: PAYMENT_PROVIDER,
      providerEventId: externalEventId(input.eventKey),
      eventType: `payment.${input.resultStatus}`,
      providerPaymentId: `${NAMESPACE}:${input.aggregate}`,
      paymentIntentId: aggregate.paymentIntentId,
      paymentAttemptId: aggregate.paymentAttemptId,
      amountMinor: AMOUNT_MINOR,
      currency: "PLN",
      occurredAt: input.occurredAt,
      rawPayload: { source: NAMESPACE, occurredAt: input.occurredAt },
    });
    this.eventIds.add(receipt.paymentEventId);
    return { paymentEventId: receipt.paymentEventId, replayed: receipt.replayed };
  }

  async apply(input: {
    aggregate: AggregateKey;
    paymentEventId: string;
    eventKey: string;
    resultStatus: "succeeded" | "failed";
    occurredAt: string;
  }) {
    const apply = this.webhook.applyPaymentResult;
    if (!apply) throw new Error("Payment result port unavailable");
    return apply({
      idempotencyKey: `${NAMESPACE}:apply:${input.eventKey}`,
      paymentIntentId: this.aggregate(input.aggregate).paymentIntentId,
      paymentEventId: input.paymentEventId,
      resultStatus: input.resultStatus,
      occurredAt: input.occurredAt,
      failureReason: input.resultStatus === "failed" ? "provider_webhook_failed" : null,
    });
  }

  async snapshot(): Promise<DurableEventSnapshot> {
    const intentIds = [...this.intentIds];
    const [clients, orders, payments, intents, attempts, events, transitions, keys, outbox] = await Promise.all([
      queryRows(this.client.from("clients").select("id").eq("id", CLIENT_ID), "clients"),
      queryRows(this.client.from("commerce_orders").select("id,status").in("id", Object.values(ORDER_IDS)), "orders"),
      queryRows(this.client.from("commerce_payments").select("id,order_id,status").in("order_id", Object.values(ORDER_IDS)), "payments"),
      queryRows(this.client.from("commerce_payment_intents").select("id,order_id,payment_id,status").in("order_id", Object.values(ORDER_IDS)), "intents"),
      queryRows(this.client.from("commerce_payment_attempts").select("id,payment_intent_id,status").in("payment_intent_id", intentIds), "attempts"),
      queryRows(this.client.from("inbound_provider_events").select("id,provider_event_id,payment_intent_id,payment_attempt_id,processing_status").in("payment_intent_id", intentIds), "events"),
      queryRows(this.client.from("commerce_payment_state_transitions").select("id").in("payment_intent_id", intentIds), "transitions"),
      queryRows(this.client.from("commerce_idempotency_keys").select("id").like("idempotency_key", `${NAMESPACE}:%`), "idempotency"),
      queryRows(this.client.from("outbox_events").select("id").in("aggregate_id", [...Object.values(ORDER_IDS), ...intentIds]), "outbox"),
    ]);
    return {
      counts: {
        clients: clients.length,
        orders: orders.length,
        payments: payments.length,
        intents: intents.length,
        attempts: attempts.length,
        events: events.length,
        transitions: transitions.length,
        idempotencyKeys: keys.length,
        outboxEvents: outbox.length,
      },
      aggregates: {
        outOfOrder: composeAggregate("outOfOrder", orders, payments, intents, attempts),
        lateSuccess: composeAggregate("lateSuccess", orders, payments, intents, attempts),
      },
      events: events.map((event) => ({
        id: text(event.id),
        eventKey: eventKey(text(event.provider_event_id)),
        paymentIntentId: text(event.payment_intent_id),
        paymentAttemptId: text(event.payment_attempt_id),
        processingStatus: text(event.processing_status),
      })),
    };
  }

  private aggregate(key: AggregateKey) {
    const aggregate = this.aggregates?.[key];
    if (!aggregate) throw new Error(`Payment-event fixture aggregate ${key} is unavailable`);
    return aggregate;
  }

  private async discoverOwnedIds(): Promise<void> {
    const intents = await queryRows(
      this.client.from("commerce_payment_intents").select("id,payment_id").in("order_id", Object.values(ORDER_IDS)),
      "discover intents",
    );
    for (const intent of intents) {
      this.intentIds.add(text(intent.id));
      this.paymentIds.add(text(intent.payment_id));
    }
    const [attempts, events, outbox] = await Promise.all([
      queryRows(this.client.from("commerce_payment_attempts").select("id").in("payment_intent_id", [...this.intentIds]), "discover attempts"),
      queryRows(this.client.from("inbound_provider_events").select("id").in("payment_intent_id", [...this.intentIds]), "discover events"),
      queryRows(this.client.from("outbox_events").select("id").in("aggregate_id", [...Object.values(ORDER_IDS), ...this.intentIds]), "discover outbox"),
    ]);
    for (const attempt of attempts) this.attemptIds.add(text(attempt.id));
    for (const event of events) this.eventIds.add(text(event.id));
    for (const event of outbox) this.outboxIds.add(text(event.id));
  }

  private async cleanupOwnedRows(): Promise<void> {
    const intents = [...this.intentIds], outbox = [...this.outboxIds];
    for (const id of outbox) await requireSuccess(this.client.from("email_sends").delete().eq("provider_response->>outboxEventId", id), "cleanup email send");
    await requireSuccess(this.client.from("communication_email_deliveries").delete().in("outbox_event_id", outbox), "cleanup deliveries");
    await requireSuccess(this.client.from("outbox_events").delete().in("id", outbox), "cleanup outbox");
    await requireSuccess(this.client.from("inbound_provider_events").delete().in("payment_intent_id", intents), "cleanup events");
    await requireSuccess(this.client.from("commerce_payment_state_transitions").delete().in("payment_intent_id", intents), "cleanup transitions");
    await requireSuccess(this.client.from("commerce_payment_intents").update({ active_attempt_id: null }).in("id", intents), "clear active attempts");
    await requireSuccess(this.client.from("commerce_payment_attempts").delete().in("payment_intent_id", intents), "cleanup attempts");
    await requireSuccess(this.client.from("commerce_payment_intents").delete().in("id", intents), "cleanup intents");
    await requireSuccess(this.client.from("commerce_payments").delete().in("id", [...this.paymentIds]), "cleanup payments");
    await requireSuccess(this.client.from("commerce_idempotency_keys").delete().like("idempotency_key", `${NAMESPACE}:%`), "cleanup idempotency");
    await requireSuccess(this.client.from("commerce_orders").delete().in("id", Object.values(ORDER_IDS)), "cleanup orders");
    await requireSuccess(this.client.from("clients").delete().eq("id", CLIENT_ID), "cleanup client");
  }

  private async residualRows(): Promise<number> {
    const outbox = [...this.outboxIds];
    const queries = [
      this.client.from("clients").select("id").eq("id", CLIENT_ID),
      this.client.from("commerce_orders").select("id").in("id", Object.values(ORDER_IDS)),
      this.client.from("commerce_payments").select("id").in("order_id", Object.values(ORDER_IDS)),
      this.client.from("commerce_payment_intents").select("id").in("order_id", Object.values(ORDER_IDS)),
      this.client.from("commerce_payment_attempts").select("id").in("id", [...this.attemptIds]),
      this.client.from("inbound_provider_events").select("id").in("provider_event_id", EVENT_KEYS.map(externalEventId)),
      this.client.from("commerce_payment_state_transitions").select("id").in("payment_intent_id", [...this.intentIds]),
      this.client.from("commerce_idempotency_keys").select("id").like("idempotency_key", `${NAMESPACE}:%`),
      this.client.from("outbox_events").select("id").in("id", outbox),
      this.client.from("communication_email_deliveries").select("id").in("outbox_event_id", outbox),
      ...outbox.map((id) => this.client.from("email_sends").select("id").eq("provider_response->>outboxEventId", id)),
    ];
    return (await Promise.all(queries.map((query, index) => queryRows(query, `residual ${index}`))))
      .reduce((total, rows) => total + rows.length, 0);
  }
}

function externalEventId(key: string): string {
  return `cp1p-${key}`;
}

function eventKey(id: string): string {
  if (!id.startsWith("cp1p-")) throw new Error(`Unexpected event id ${id}`);
  return id.slice("cp1p-".length);
}

function composeAggregate(
  key: AggregateKey,
  orders: Row[],
  payments: Row[],
  intents: Row[],
  attempts: Row[],
): DurableEventAggregate {
  const order = one(orders, "id", ORDER_IDS[key]);
  const intent = one(intents, "order_id", ORDER_IDS[key]);
  const payment = one(payments, "id", text(intent.payment_id));
  const attempt = one(attempts, "payment_intent_id", text(intent.id));
  return {
    orderId: text(order.id),
    paymentId: text(payment.id),
    paymentIntentId: text(intent.id),
    paymentAttemptId: text(attempt.id),
    orderStatus: text(order.status),
    paymentStatus: text(payment.status),
    intentStatus: text(intent.status),
    attemptStatus: text(attempt.status),
  };
}

async function queryRows(
  query: PromiseLike<{ data: unknown; error: { message?: string } | null }>,
  label: string,
): Promise<Row[]> {
  const result = await query;
  if (result.error) throw new Error(`${label}: ${result.error.message ?? "query failed"}`);
  if (!Array.isArray(result.data)) throw new Error(`${label}: expected row array`);
  return result.data as Row[];
}

async function requireSuccess(
  query: PromiseLike<{ error: { message?: string } | null }>,
  label: string,
): Promise<void> {
  const result = await query;
  if (result.error) throw new Error(`${label}: ${result.error.message ?? "query failed"}`);
}

function one(rows: Row[], key: string, value: string): Row {
  const matches = rows.filter((row) => text(row[key]) === value);
  if (matches.length !== 1) throw new Error(`Expected one ${key}=${value}, received ${matches.length}`);
  return matches[0];
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected non-empty database identifier");
  return value;
}

function dataGatewayEndpointEntries(env: EnvLike): Array<[string, string]> {
  const namespaces = Object.keys(env)
    .filter((key) => !key.startsWith("VITE_") && key.endsWith(SERVICE_ROLE_SUFFIX))
    .map((key) => key.slice(0, -SERVICE_ROLE_SUFFIX.length));
  if (namespaces.length !== 1) return [];
  return [`${namespaces[0]}_URL`, `VITE_${namespaces[0]}_URL`, "DATABASE_URL", "DB_URL"]
    .flatMap((key) => env[key]?.trim() ? [[key, env[key]!.trim()] as [string, string]] : []);
}

function readDataGatewayEndpoint(env: EnvLike): string | null {
  return dataGatewayEndpointEntries(env)
    .find(([key]) => !/(?:DATABASE_URL|DB_URL)$/i.test(key))?.[1] ?? null;
}

function assertLocalDatabase(env: EnvLike, endpoint: string): void {
  const loopback = (value: string) => {
    try { return ["localhost", "127.0.0.1", "::1"].includes(new URL(value).hostname.replace(/^\[|\]$/g, "").toLowerCase()); } catch { return false; }
  };
  if (!loopback(endpoint)) throw new Error("Local conformance requires a loopback database URL");
  const hosted = Object.entries(env).some(([key, value]) => key !== "NODE_ENV" && /(?:_ENVIRONMENT|_ENV)$/.test(key) && /^(?:production|preview|staging)$/i.test(value?.trim() ?? ""));
  if (env.NODE_ENV === "production" || hosted) throw new Error("Local conformance refuses hosted environments");
  for (const [key, value] of dataGatewayEndpointEntries(env)) {
    if (!loopback(value)) throw new Error(`Local conformance refuses non-loopback endpoint ${key}`);
  }
}
