import { createHash } from "node:crypto";
import {
  CheckoutRecoveryPayError,
  type CheckoutRecoveryPayService,
} from "../../domains/commerce/checkoutRecoveryPayService.js";
import type { CheckoutRecoveryOrderReadPort, CheckoutRecoveryOrderSnapshot } from "../../domains/commerce/checkoutRecoveryOrderPort.js";
import type { CheckoutRecoveryStartReadPort } from "../../domains/commerce/checkoutRecoveryStartPort.js";
import type {
  CheckoutRecoveryTokenContext,
  CheckoutRecoveryTokenInspection,
  CheckoutRecoveryTokenPort,
} from "../../domains/commerce/checkoutRecoveryToken.js";

type RpcClient = {
  rpc(name: string, args?: Record<string, unknown>): Promise<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
};

export function createPostgresCheckoutRecoveryStartPort(
  actor: RpcClient,
): CheckoutRecoveryStartReadPort {
  const find = async (orderId: string | null, subscriptionId: string | null) => {
    const data = await call(actor, "customer_checkout_recovery_find_as_actor", {
      p_order_id: orderId,
      p_subscription_id: subscriptionId,
    });
    return data === null ? null : startRow(data);
  };
  return {
    findRecoverableOrder: ({ subscriptionId }) => find(null, subscriptionId),
    findRecoverableOrderById: ({ orderId }) => find(orderId, null),
    async findOwnedOrderContextById({ orderId }) {
      const row = await find(orderId, null);
      return row && {
        orderId: row.orderId,
        mode: row.mode,
        subscriptionId: row.subscriptionId,
        clientHasLiveOrPendingSubscription: row.clientHasLiveOrPendingSubscription,
      };
    },
    async clientHasLiveOrPendingSubscription() {
      return (await call(actor, "customer_has_live_subscription_as_actor")) === true;
    },
  };
}

export function createPostgresCheckoutRecoveryTokenPort(
  service: RpcClient,
  actor?: RpcClient,
  onValidatedHash?: (hash: string) => void,
): CheckoutRecoveryTokenPort {
  return {
    async issue({ orderId, rawToken, expiresAt }) {
      if (!actor) throw new Error("customer checkout recovery actor unavailable");
      const data = await call(actor, "customer_checkout_recovery_token_issue_as_actor", {
        p_order_id: orderId,
        p_token_hash: hash(rawToken),
        p_expires_at: expiresAt,
      });
      if (typeof data !== "string") throw new Error("customer checkout recovery token response invalid");
      return data;
    },
    async validate(rawToken, now) {
      const tokenHash = hash(rawToken);
      const inspected = await inspect(service, tokenHash, now);
      if (!inspected || inspected.tokenState !== "active" || inspected.status !== "pending_payment") return null;
      onValidatedHash?.(tokenHash);
      return {
        tokenId: inspected.tokenId,
        orderId: inspected.orderId,
        clientId: inspected.clientId,
        mode: inspected.mode ?? "one_time_order",
        status: inspected.status ?? "pending_payment",
      } as CheckoutRecoveryTokenContext;
    },
    inspect: (rawToken, now) => inspect(service, hash(rawToken), now),
  };
}

export function createPostgresCheckoutRecoveryOrderPort(service: RpcClient): CheckoutRecoveryOrderReadPort {
  const read = async (orderId: string): Promise<CheckoutRecoveryOrderSnapshot | null> => {
    const data = await call(service, "customer_checkout_recovery_order", { p_order_id: orderId });
    if (data === null) return null;
    const row = object(data);
    const id = required(row, "orderId");
    const clientId = required(row, "clientId");
    const mode = required(row, "mode") === "subscription_cycle" ? "subscription_cycle" : "one_time_order";
    return {
      orderId: id,
      orderRef: `order_${id}`,
      orderNumber: id,
      clientId,
      status: required(row, "status"),
      mode,
      totalMinor: number(row, "totalMinor"),
      currency: required(row, "currency"),
      petName: null,
      cadenceDays: null,
      createdAt: required(row, "createdAt"),
      customerEmail: optional(row, "customerEmail"),
      customerName: null,
      paymentIntentId: optional(row, "paymentIntentId"),
      paymentIntentStatus: optional(row, "paymentIntentStatus") as CheckoutRecoveryOrderSnapshot["paymentIntentStatus"],
      subscriptionId: optional(row, "subscriptionId"),
      subscriptionCycleId: optional(row, "subscriptionCycleId"),
    };
  };
  return { getRecoveryOrder: ({ orderId }) => read(orderId), getLatestRecoveryOrder: ({ orderId }) => read(orderId) };
}

export function createPostgresCheckoutRecoveryPayService(
  service: RpcClient,
  validatedTokenHash: () => string | null,
): CheckoutRecoveryPayService {
  return { async pay(input) {
    if (input.paymentProvider !== "hidden_rehearsal" || input.paymentExecution !== undefined) {
      throw new CheckoutRecoveryPayError("provider_execution_failed", input.order.orderId);
    }
    const tokenHash = validatedTokenHash();
    if (!tokenHash) throw new CheckoutRecoveryPayError("provider_execution_failed", input.order.orderId);
    const data = object(await call(service, "customer_checkout_recovery_settle", {
      p_token_hash: tokenHash,
      p_idempotency_key: input.idempotencyKey,
    }));
    return {
      orderId: required(data, "orderId"),
      paymentIntentId: required(data, "paymentIntentId"),
      clientId: required(data, "clientId"),
      status: "paid",
      paymentAttemptId: optional(data, "paymentAttemptId"),
      provider: required(data, "provider"),
      providerPaymentId: optional(data, "providerPaymentId"),
      clientAction: { kind: "none" },
    };
  } };
}

async function inspect(service: RpcClient, tokenHash: string, now?: Date): Promise<CheckoutRecoveryTokenInspection | null> {
  const data = await call(service, "customer_checkout_recovery_token_inspect", {
    p_token_hash: tokenHash,
    ...(now ? { p_now: now.toISOString() } : {}),
  });
  if (data === null) return null;
  const row = object(data);
  return {
    tokenId: required(row, "tokenId"),
    orderId: required(row, "orderId"),
    clientId: required(row, "clientId"),
    mode: optional(row, "mode"),
    status: optional(row, "status"),
    subscriptionId: optional(row, "subscriptionId"),
    tokenState: required(row, "tokenState"),
  };
}

async function call(client: RpcClient, name: string, args?: Record<string, unknown>) {
  const { data, error } = await client.rpc(name, args);
  if (error) throw error;
  return data;
}
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("customer checkout recovery response invalid");
  return value as Record<string, unknown>;
}
function required(value: Record<string, unknown>, key: string) {
  const field = value[key];
  if (typeof field !== "string" || !field) throw new Error("customer checkout recovery response invalid");
  return field;
}
function optional(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field ? field : null;
}
function number(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isSafeInteger(field)) throw new Error("customer checkout recovery response invalid");
  return field;
}
function startRow(value: unknown) {
  const row = object(value);
  return {
    orderId: required(row, "orderId"),
    createdAt: required(row, "createdAt"),
    mode: required(row, "mode") === "subscription_cycle" as const ? "subscription_cycle" as const : "one_time_order" as const,
    subscriptionId: optional(row, "subscriptionId"),
    clientHasLiveOrPendingSubscription: row.clientHasLiveOrPendingSubscription === true,
  };
}
