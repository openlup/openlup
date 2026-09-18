import { strict as assert } from "node:assert";
import pg from "pg";
import { runOmnipackStockSyncCron } from "../api/_cron/omnipackStockSyncJob.js";
import lowStockRoute from "../server/bff/admin/fulfillment/low-stock-evidence.js";
import { resolveFulfillmentStockSyncBinding } from "../server/runtime/fulfillment/fulfillmentConvergenceBinding.js";
import type { VercelRequest, VercelResponse } from "../server/_lib/types/vercel.js";

const connectionString = requireLocalDatabase(process.env);
const operatorId = "8c454a60-7f0c-49a8-8b42-8109c22bf543";
const token = "fulfillment-stock-proof-operator-token-0000000001";
const sourceKey = "proof-stock-source";
const env = {
  PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: connectionString,
  FULFILLMENT_STOCK_SOURCE_KEY: sourceKey,
  COMMERCE_OMNIPACK_STOCK_SYNC_ENABLED: "true", CRON_SECRET: "proof-cron-secret",
  PLATFORM_OPERATOR_ID: operatorId, PLATFORM_OPERATOR_TOKEN: token,
};

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString });
  await pool.query("INSERT INTO public.platform_communication_operators(principal_id) VALUES($1)", [operatorId]);
  const productId = "5c0a3dbd-4a4f-46a4-a13c-9a3959c3f40f";
  await pool.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,'proof-product','Proof product')", [productId]);
  await pool.query("INSERT INTO public.catalog_skus(product_id,sku,title) VALUES($1,'PROOF-SKU','Proof SKU')", [productId]);
  await pool.end();

  const seeded = resolveFulfillmentStockSyncBinding(env);
  assert(seeded.binding);
  await seeded.binding.recordCursor({
    status: "succeeded", lastStockSyncedAt: "2026-08-12T00:00:00.000Z",
    lastMovementOccurredAt: null, cursor: {}, error: {},
  });
  await seeded.binding.close();

  const provider = {
    async getStock() { return [{ provider: "omnipack" as const, sku: "PROOF-SKU", totalQuantity: 12, forSaleQuantity: 10, reservedOrUnavailableQuantity: 2 }]; },
    async getStockMovements() { return []; },
  };
  const result = await runOmnipackStockSyncCron({
    method: "POST", headers: { authorization: "Bearer proof-cron-secret" },
  } as unknown as VercelRequest, env, undefined, () => provider);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.checked, 1);

  Object.assign(process.env, env);
  const route = await callRoute();
  assert.equal(route.status, 200, JSON.stringify(route.body));
  const data = route.body.data as { openCount: number; items: Array<{ thresholdKind: string }> };
  assert.equal(data.openCount, 1);
  assert.equal(data.items[0]?.thresholdKind, "stale_sync");

  const restarted = resolveFulfillmentStockSyncBinding(env);
  assert(restarted.binding);
  const original = {
    idempotencyKey: "proof-replay-current", sku: "PROOF-SKU", providerTotalQuantity: 12,
    providerForSaleQuantity: 10, providerReservedUnavailableQuantity: 2,
    inventoryClass: "sellable" as const, lastSyncedAt: "2026-08-13T12:00:00.000Z",
    staleAfter: "2026-08-13T18:00:00.000Z", syncRunId: "proof-replay", evidence: {},
  };
  assert.equal((await restarted.binding.recordProviderStockCurrent(original)).replayed, false);
  const advanced = {
    ...original, idempotencyKey: "proof-newer-current", providerTotalQuantity: 13,
    providerForSaleQuantity: 11, lastSyncedAt: "2026-08-13T13:00:00.000Z",
    staleAfter: "2026-08-13T19:00:00.000Z", syncRunId: "proof-newer",
  };
  assert.equal((await restarted.binding.recordProviderStockCurrent(advanced)).replayed, false);
  await restarted.binding.close();
  const replayed = resolveFulfillmentStockSyncBinding(env);
  assert(replayed.binding);
  assert.equal((await replayed.binding.recordProviderStockCurrent(original)).replayed, true);
  const cursor = await replayed.binding.readCursor();
  assert.equal(cursor?.status, "succeeded");
  await replayed.binding.close();

  const readback = new pg.Pool({ connectionString });
  const latest = await readback.query<{ total_quantity: number; idempotency_key: string }>(
    "SELECT total_quantity, idempotency_key FROM public.fulfillment_stock_current WHERE source_key=$1 AND sku='PROOF-SKU'",
    [sourceKey],
  );
  assert.deepEqual(latest.rows[0], { total_quantity: 13, idempotency_key: "proof-newer-current" });
  assert.equal((await readback.query(
    "SELECT 1 FROM public.fulfillment_stock_operations WHERE idempotency_key=$1",
    [original.idempotencyKey],
  )).rowCount, 1);
  await readback.end();
  process.stdout.write("FULFILLMENT_STOCK_EVIDENCE_PROOF: cron,readback,replay,restart=green\n");
}

async function callRoute(): Promise<{ status: number; body: Record<string, unknown> }> {
  const output = { status: 200, body: {} as Record<string, unknown> };
  const req = { method: "GET", headers: { authorization: `Bearer ${token}` },
    query: { statusFilter: "all" } } as unknown as VercelRequest;
  const res = { statusCode: 200, setHeader() {}, status(code: number) { output.status = code; return res; },
    json(body: Record<string, unknown>) { output.body = body; return res; } } as unknown as VercelResponse;
  await lowStockRoute(req, res);
  return output;
}

function requireLocalDatabase(envInput: NodeJS.ProcessEnv): string {
  if (envInput.FULFILLMENT_STOCK_PROOF_ALLOW_LOCAL !== "true") throw new Error("local proof flag required");
  const value = envInput.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL is required");
  const host = new URL(value).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") throw new Error("proof refuses non-local database");
  return value;
}

await main();
