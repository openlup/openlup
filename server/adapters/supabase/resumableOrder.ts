import type {
  CommerceResumableOrderReadPort,
  ResumableOrderSnapshot,
} from "../../../src/domains/commerce/ports.js";
import { deriveAsyncCheckoutStatus } from "../../../src/domains/commerce/paymentStatus.js";
import type {
  PaymentAttemptStatus,
  PaymentIntentStatus,
} from "../../../src/domains/payment/types.js";

/**
 * Statuses that mean "the payment is still in flight" and the order should be
 * resumed rather than duplicated. Derived from {@link deriveAsyncCheckoutStatus}
 * so it stays in lock-step with the canonical mapping the FE polls against.
 * Deliberately EXCLUDES `paid` (done) and `failed`/`expired` (dead) — those let
 * the customer start a fresh order.
 */
const RESUMABLE_STATUSES = new Set([
  "processing",
  "requires_action",
  "pending_provider_action",
]);

/** How many recent orders to inspect (newest first) before giving up. */
const SCAN_LIMIT = 5;

/**
 * The scope `commerce_create_order_draft_with_outbox` keys its idempotency rows
 * under, and the prefixed form it records the order id in. Both are constants in
 * that function (`v_scope`, and `'order_' || v_order_id::text` on completion),
 * so this is a read of what the producer wrote, not a convention invented here.
 */
const ORDER_DRAFT_SCOPE = "commerce.order_draft.create";
const ORDER_ID_PREFIX = "order_";

interface RpcError {
  message?: string;
}

interface ListQuery<T> {
  eq(column: string, value: unknown): ListQuery<T>;
  gte(column: string, value: unknown): ListQuery<T>;
  order(column: string, options: { ascending: boolean }): ListQuery<T>;
  limit(count: number): PromiseLike<{ data: T[] | null; error: RpcError | null }>;
}

interface SingleQuery<T> {
  eq(column: string, value: unknown): SingleQuery<T>;
  order(column: string, options: { ascending: boolean }): SingleQuery<T>;
  limit(count: number): PromiseLike<{ data: T[] | null; error: RpcError | null }>;
}

/**
 * The minimal query surface this port needs. Structural on purpose and named for
 * the read, not the vendor: nothing here is Supabase-specific, and the module
 * path already says where the implementation comes from.
 */
export interface ResumableOrderClient {
  from<T = Record<string, unknown>>(table: string): {
    select(columns: string): ListQuery<T> & SingleQuery<T>;
  };
}

interface OrderRow {
  id: string;
  status: string;
  created_at: string;
  metadata?: Record<string, unknown> | null;
}

interface IntentRow {
  id: string;
  status: string;
  active_attempt_id: string | null;
}

interface AttemptRow {
  status: string;
}

interface IdempotencyKeyRow {
  metadata: Record<string, unknown> | null;
}

/**
 * Reads the newest still-in-flight order for a client. Joins are done in code
 * (no DB view) to mirror {@link createSupabasePaymentStatusPort} and keep the
 * query within the structural client interface. Returns null on no match; THROWS
 * on transport errors so the caller can fail-open (a resume-lookup failure must
 * never block a real checkout).
 */
export function createSupabaseResumableOrderPort(
  client: ResumableOrderClient,
): CommerceResumableOrderReadPort {
  return {
    async findResumableOrderForClient(input): Promise<ResumableOrderSnapshot | null> {
      const since = new Date(input.now.getTime() - input.withinMinutes * 60_000).toISOString();
      // Resolved once: the submitting journey is fixed for the whole scan.
      const journeyOrderId = await readOrderIdForJourney(client, input.journeyKey);
      const { data: orders, error: ordersError } = await client
        .from<OrderRow>("commerce_orders")
        .select("id, status, created_at, metadata")
        .eq("client_id", input.clientId)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(SCAN_LIMIT);
      if (ordersError) throw new Error(`commerce_orders: ${ordersError.message ?? "query failed"}`);
      if (!orders?.length) return null;

      for (const order of orders) {
        const intent = await readLatestIntent(client, order.id);
        if (!intent) continue;
        const attemptStatus = intent.active_attempt_id
          ? await readAttemptStatus(client, intent.active_attempt_id)
          : null;
        const derived = deriveAsyncCheckoutStatus({
          intentStatus: intent.status as PaymentIntentStatus,
          attemptStatus: attemptStatus as PaymentAttemptStatus | null,
          orderStatus: order.status,
        });
        if (RESUMABLE_STATUSES.has(derived)) {
          return {
            orderId: order.id,
            paymentIntentId: intent.id,
            status: derived,
            metadata: order.metadata ?? null,
            sameJourney: journeyOrderId === `${ORDER_ID_PREFIX}${order.id}`,
          };
        }
      }
      return null;
    },
  };
}

async function readLatestIntent(
  client: ResumableOrderClient,
  orderId: string,
): Promise<IntentRow | null> {
  const { data, error } = await client
    .from<IntentRow>("commerce_payment_intents")
    .select("id, status, active_attempt_id")
    .eq("order_id", orderId)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`commerce_payment_intents: ${error.message ?? "query failed"}`);
  return data?.[0] ?? null;
}

async function readAttemptStatus(
  client: ResumableOrderClient,
  attemptId: string,
): Promise<string | null> {
  const { data, error } = await client
    .from<AttemptRow>("commerce_payment_attempts")
    .select("status")
    .eq("id", attemptId)
    .limit(1);
  if (error) throw new Error(`commerce_payment_attempts: ${error.message ?? "query failed"}`);
  return data?.[0]?.status ?? null;
}


/**
 * Which order this journey key already produced, in the prefixed form the
 * producer stores, or null when the key has produced none.
 *
 * A FORWARD lookup on the unique `(scope, idempotency_key)` index, because the
 * order itself does not carry its journey key: `commerce_orders.metadata` holds
 * only `paymentStatus`, `quoteSnapshot` and `orderDraftSnapshot`. Reading the
 * key's row is therefore the only way to ask "is this in-flight order mine".
 *
 * Errors are swallowed to null rather than thrown. A null answer means "not my
 * journey", which routes the caller into the cart comparison — the STRICTER of
 * the two paths — so a lookup failure can only cost an extra comparison, never
 * authorize a resume.
 */
async function readOrderIdForJourney(
  client: ResumableOrderClient,
  journeyKey: string,
): Promise<string | null> {
  const { data, error } = await client
    .from<IdempotencyKeyRow>("commerce_idempotency_keys")
    .select("metadata")
    .eq("scope", ORDER_DRAFT_SCOPE)
    .eq("idempotency_key", journeyKey)
    .limit(1);
  if (error) return null;
  const orderId = data?.[0]?.metadata?.orderId;
  return typeof orderId === "string" ? orderId : null;
}
