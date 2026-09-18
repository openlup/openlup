import { vi } from "vitest";
import type { VercelRequest } from "../../../server/_lib/types/vercel.js";
import { COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE } from "../../domains/commerce/outboxEventContracts.js";

export const EVENT_ID = "9e0f2a64-0000-4000-8000-000000000001";
export const ORDER_UUID = "11111111-1111-4111-8111-111111111111";

export const FULL_ENV = {
  CRON_SECRET: "secret",
  COMMERCE_OUTBOX_DISPATCH_ENABLED: "true",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  RESEND_API_KEY: "re_test",
};

export function request(headers: Record<string, string> = {}, method = "POST"): VercelRequest {
  return { method, headers, query: {} } as VercelRequest;
}

export function authed(): VercelRequest {
  return request({ authorization: "Bearer secret" });
}

type RpcResult = { data: unknown; error: { message?: string } | null };

export function scriptedClient(script: (name: string, args: Record<string, unknown>) => RpcResult) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    neq: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => ({ data: { client_id: null }, error: null })),
    limit: vi.fn(async () => ({ data: [], error: null })),
    insert: vi.fn(async () => ({ error: null })),
  };
  return {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => script(name, args)),
    from: vi.fn(() => builder),
  };
}

export function gatewayFactoryForClient(client: unknown) {
  const asService = vi.fn(async (callback: (serviceClient: unknown) => unknown) => callback(client));
  const factory = vi.fn(() => ({ asService }));
  return { factory, asService };
}

export function claimedRow(): Record<string, unknown> {
  return {
    id: EVENT_ID,
    created_at: "2026-06-12T10:00:00.000Z",
    available_at: "2026-06-12T10:05:00.000Z",
    processed_at: null,
    aggregate_type: "commerce_order",
    aggregate_id: "order_x",
    event_type: COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE,
    idempotency_key: "idem-1",
    status: "processing",
    attempts: 1,
    payload: { orderUuid: ORDER_UUID, orderId: "order_x" },
    error: null,
    metadata: { claimToken: "tok-1" },
  };
}
