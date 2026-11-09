import type { PgQueryExecutor } from "../../data/index.js";
import {
  hashCheckoutRecoveryToken,
  type CheckoutRecoveryTokenInspection,
  type CheckoutRecoveryTokenPort,
} from "./checkoutRecoveryToken.js";

export interface PostgresCheckoutRecoveryTokenInspection extends CheckoutRecoveryTokenInspection {
  /** Persisted quote/activation cadence; null for a one-time order. */
  cadenceDays: number | null;
}

export interface PostgresCheckoutRecoveryTokenPort extends CheckoutRecoveryTokenPort {
  inspect(rawToken: string, now?: Date): Promise<PostgresCheckoutRecoveryTokenInspection | null>;
}

/**
 * Trusted-host service capability for an order the host has already admitted.
 * Supply a dedicated transaction lane with effective service_role privileges;
 * never share an actor lane or authorize issuance from an email or order ID alone.
 * No principal or caller-selected client is accepted. The shared expiresAt input
 * is ignored: PostgreSQL computes exactly order.created_at + 24 hours.
 * New checkout links preserve earlier links of the same order until expiry or payment.
 * Pending renewal-cycle orders are refused. Replaying the same
 * hash returns its original ID without reactivating or rotating any link.
 * This port neither settles payments nor sends mail.
 */
export function createPostgresCheckoutRecoveryTokenPort(
  executor: { run<T>(work: (gateway: unknown) => Promise<T>): Promise<T> },
): PostgresCheckoutRecoveryTokenPort {
  async function run<T>(work: (db: PgQueryExecutor) => Promise<T>): Promise<T> {
    try {
      return await executor.run(async gateway => {
        const db = gateway as PgQueryExecutor;
        await db.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
        const privilege = (await db.query(
          "SELECT pg_catalog.pg_has_role(current_user, 'service_role', 'USAGE') AS allowed",
        )).rows[0];
        if (privilege?.allowed !== true) throw new Error("checkout_recovery_service_required");
        return work(db);
      });
    } catch (error) {
      // Driver details may contain bound values. Never attach them or a cause.
      const message = error instanceof Error ? error.message : "";
      throw new Error(errors.has(message) ? message : "checkout_recovery_storage_failed");
    }
  }

  async function inspect(rawToken: string, now?: Date): Promise<PostgresCheckoutRecoveryTokenInspection | null> {
    const tokenHash = hashCheckoutRecoveryToken(rawToken);
    return run(async db => {
      const row = (await db.query(`WITH inspected AS MATERIALIZED (
        SELECT public.customer_checkout_recovery_token_inspect(
          $1::text, COALESCE($2::timestamptz, pg_catalog.statement_timestamp())) AS value
      ) SELECT inspected.value,
          orders.metadata #> '{orderDraftSnapshot,context}' AS draft_context,
          orders.metadata #> '{quoteSnapshot,quote,context}' AS quote_context,
          activation.cadence_days AS activation_cadence
        FROM inspected
        LEFT JOIN public.commerce_orders orders ON orders.id = (inspected.value->>'orderId')::uuid
        LEFT JOIN public.subscription_activations activation ON activation.order_id = orders.id`,
      [tokenHash, now?.toISOString() ?? null])).rows[0];
      if (!row?.value) return null;
      const value = record(row.value);
      const state = text(value, "tokenState");
      const tokenState = state === "consumed" ? "order_not_recoverable"
        : ["active", "expired", "revoked"].includes(state) ? state : "unknown";
      const facts = subscriptionFacts(row, value.mode);
      return {
        tokenId: text(value, "tokenId"), orderId: text(value, "orderId"), clientId: text(value, "clientId"),
        mode: facts.mode, cadenceDays: facts.cadenceDays,
        status: text(value, "status"), subscriptionId: nullableText(value.subscriptionId), tokenState,
      };
    });
  }

  return {
    async issue({ orderId, rawToken }) {
      const tokenHash = hashCheckoutRecoveryToken(rawToken);
      return run(async db => {
        // READ COMMITTED obtains fresh token facts after waiting on the order.
        const order = (await db.query(`SELECT client_id, status, subscription_cycle_id,
            created_at + interval '24 hours' > pg_catalog.clock_timestamp() AS unexpired
          FROM public.commerce_orders WHERE id = $1::uuid FOR UPDATE`, [orderId])).rows[0];
        if (!order || order.status !== "pending_payment" || !order.client_id || !order.unexpired || order.subscription_cycle_id != null) {
          throw new Error("checkout_recovery_order_not_recoverable");
        }
        if (!(await db.query("SELECT id FROM public.clients WHERE id = $1::uuid FOR UPDATE", [order.client_id])).rows.length) {
          throw new Error("checkout_recovery_order_not_recoverable");
        }
        const previous = (await db.query(`SELECT token.id, token.order_id = orders.id AS same_order,
            orders.created_at + interval '24 hours' > pg_catalog.clock_timestamp() AS unexpired
          FROM public.commerce_orders orders
          LEFT JOIN public.commerce_checkout_recovery_tokens token ON token.token_hash = $2
          WHERE orders.id = $1::uuid`, [orderId, tokenHash])).rows[0];
        if (!previous?.unexpired) throw new Error("checkout_recovery_order_not_recoverable");
        if (previous.id) {
          if (!previous.same_order) throw new Error("checkout_recovery_hash_conflict");
          return text(previous, "id");
        }
        const inserted = (await db.query(`INSERT INTO public.commerce_checkout_recovery_tokens
            (order_id, client_id, token_hash, expires_at, created_at)
          SELECT id, client_id, $2, created_at + interval '24 hours', pg_catalog.clock_timestamp()
            FROM public.commerce_orders
            WHERE id = $1::uuid AND created_at + interval '24 hours' > pg_catalog.clock_timestamp()
          RETURNING id`, [orderId, tokenHash])).rows[0];
        if (!inserted) throw new Error("checkout_recovery_order_not_recoverable");
        return text(inserted, "id");
      });
    },
    inspect,
    async validate(rawToken, now) {
      const value = await inspect(rawToken, now);
      if (!value || value.tokenState !== "active" || value.status !== "pending_payment" || !value.mode) return null;
      return { tokenId: value.tokenId, orderId: value.orderId, clientId: value.clientId, mode: value.mode, status: value.status };
    },
  };
}

const errors = new Set([
  "checkout_recovery_service_required", "checkout_recovery_order_not_recoverable",
  "checkout_recovery_hash_conflict", "checkout_recovery_response_invalid",
]);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("checkout_recovery_response_invalid");
  return value as Record<string, unknown>;
}
function text(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || !field) throw new Error("checkout_recovery_response_invalid");
  return field;
}
function nullableText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value) throw new Error("checkout_recovery_response_invalid");
  return value;
}

function subscriptionFacts(row: Record<string, unknown>, nativeMode: unknown) {
  const contexts = [row.draft_context, row.quote_context].filter(value => value != null).map(record);
  const modes = contexts.map(context => context.mode).filter(value => value != null);
  const cadences = [...contexts.map(context => context.cadenceDays), row.activation_cadence]
    .filter(value => value != null);
  if (modes.some(mode => mode !== "one_time" && mode !== "subscription")
    || new Set(modes).size > 1
    || cadences.some(value => typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    || new Set(cadences).size > 1) throw new Error("checkout_recovery_response_invalid");
  const subscription = nativeMode === "subscription_cycle" || modes.includes("subscription") || cadences.length > 0;
  if ((subscription && (modes.includes("one_time") || (modes.includes("subscription") && cadences.length === 0)))
    || (nativeMode !== "one_time_order" && nativeMode !== "subscription_cycle")) {
    throw new Error("checkout_recovery_response_invalid");
  }
  return { mode: subscription ? "subscription_cycle" : "one_time_order", cadenceDays: (cadences[0] as number | undefined) ?? null };
}
