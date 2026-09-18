import type { ReferenceJourneyOrderReadbackPort } from "../../src/domains/commerce/referenceJourneyReadbackContracts.js";

type Result<T> = { data: T | null; error: unknown };
type Query = {
  select: (columns: string) => Query;
  eq: (column: string, value: unknown) => Query;
  limit: (count: number) => PromiseLike<Result<Array<Record<string, unknown>>>>;
  maybeSingle: () => PromiseLike<Result<Record<string, unknown>>>;
};
type GatewayClient = { from: (table: "clients" | "commerce_orders") => Query };
type ServiceOnlyPort = {
  asService: <T>(work: (client: unknown) => Promise<T>) => Promise<T>;
};
type AuditClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};
type OrderRow = { id?: unknown; client_id?: unknown };

export function createReferenceJourneyAuditClient(
  resolveServicePort: () => ServiceOnlyPort | null,
): AuditClient {
  return {
    rpc: async (fn, args) => {
      const servicePort = resolveServicePort();
      if (!servicePort) throw new Error("Operator service data port is unavailable");
      return servicePort.asService(async (gateway) => rpcClient(gateway).rpc(fn, args));
    },
  };
}

export const referenceJourneyOrderReadbackAdapter: ReferenceJourneyOrderReadbackPort = {
  async listCustomerOrders(gateway, userId, limit) {
    const clientId = await customerId(gateway, userId);
    if (!clientId) return null;
    const result = await client(gateway).from("commerce_orders").select("id").eq("client_id", clientId).limit(limit);
    if (result.error) throw result.error;
    return (result.data ?? []).map(toCustomerOrder).filter((row): row is { orderId: string } => row !== null);
  },
  async getCustomerOrder(gateway, userId, orderId) {
    const clientId = await customerId(gateway, userId);
    if (!clientId) return null;
    const result = await client(gateway).from("commerce_orders").select("id").eq("client_id", clientId).eq("id", orderId).maybeSingle();
    if (result.error) throw result.error;
    return toCustomerOrder(result.data);
  },
  async listOperatorOrders(gateway, limit) {
    const result = await client(gateway).from("commerce_orders").select("id, client_id").limit(limit);
    if (result.error) throw result.error;
    return (result.data ?? []).map(toOperatorOrder).filter((row): row is { orderId: string; clientId: string | null } => row !== null);
  },
  async getOperatorOrder(gateway, orderId) {
    const result = await client(gateway).from("commerce_orders").select("id, client_id").eq("id", orderId).maybeSingle();
    if (result.error) throw result.error;
    return toOperatorOrder(result.data);
  },
};

async function customerId(gateway: unknown, userId: string): Promise<string | null> {
  const result = await client(gateway).from("clients").select("id").eq("auth_user_id", userId).maybeSingle();
  if (result.error) throw result.error;
  return typeof result.data?.id === "string" ? result.data.id : null;
}

function client(gateway: unknown): GatewayClient { return gateway as GatewayClient; }
function rpcClient(gateway: unknown): AuditClient { return gateway as AuditClient; }
function toCustomerOrder(row: Record<string, unknown> | null): { orderId: string } | null { return typeof row?.id === "string" ? { orderId: row.id } : null; }
function toOperatorOrder(row: Record<string, unknown> | null): { orderId: string; clientId: string | null } | null {
  if (typeof row?.id !== "string") return null;
  const clientId = (row as OrderRow).client_id;
  return { orderId: row.id, clientId: typeof clientId === "string" ? clientId : null };
}
