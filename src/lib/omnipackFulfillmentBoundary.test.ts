import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const fulfillmentSql = read("supabase/migrations/20260605123000_commerce_fulfillment_integration_control_plane.sql");
const stockAuthoritySql = read("supabase/migrations/20260710130000_fulfillment_provider_stock_authority.sql");
const hardeningSql = read("supabase/migrations/20260613221000_admin_oms_preview_hardening.sql");
const omnipackMapper = read("server/infra/omnipack/outboundOrderMapper.ts");
const omnipackOutboundPayload = read("server/_lib/omnipackOutboundOrderPayload.ts");
const omnipackDocs = read("docs/COMMERCE_OMNIPACK_INTEGRATION.md");
const docsIndex = read("docs/README.md");

describe("hidden Omnipack fulfillment boundary", () => {
  it("uses existing local fulfillment RPCs for provider attempts, labels, tracking, and handoff", () => {
    for (const required of [
      "commerce_fulfillment_record_provider_attempt",
      "commerce_fulfillment_record_label_created",
      "commerce_fulfillment_record_tracking_event",
      "commerce_fulfillment_mark_handed_over",
      "commerce_fulfillment_provider_attempts",
    ]) {
      expect(fulfillmentSql).toContain(required);
    }
  });

  it("keeps original inventory consumption only inside the explicit handoff boundary", () => {
    const labelFunction = extractFunction("commerce_fulfillment_record_label_created");
    const trackingFunction = extractFunction("commerce_fulfillment_record_tracking_event");
    const handoffFunction = extractFunction("commerce_fulfillment_mark_handed_over");

    expect(labelFunction).not.toContain("inventory_consume_reservation_for_fulfillment");
    expect(trackingFunction).not.toContain("inventory_consume_reservation_for_fulfillment");
    expect(handoffFunction).toContain("inventory_consume_reservation_for_fulfillment");
    expect(handoffFunction).toContain("p_idempotency_key || ':' || v_reservation_id::text");
  });

  it("adds a separate provider-stock-consumed boundary for OmniPack finished picking", () => {
    const consumedFunction = extractFunctionFrom(stockAuthoritySql, "commerce_fulfillment_mark_provider_stock_consumed");
    const handoffFunction = extractFunctionFrom(stockAuthoritySql, "commerce_fulfillment_mark_handed_over");

    expect(consumedFunction).toContain("operation_type, idempotency_key");
    expect(consumedFunction).toContain("'packed'");
    expect(consumedFunction).toContain("inventory_consume_reservation_for_fulfillment");
    expect(handoffFunction).toContain("status NOT IN ('label_created', 'packed')");
  });

  it("keeps tracking events behind handoff and active tracking refs in preview hardening", () => {
    const trackingFunction = extractFunctionFrom(hardeningSql, "commerce_fulfillment_record_tracking_event");

    expect(trackingFunction).toContain("commerce_fulfillment_tracking_before_handoff_forbidden");
    expect(trackingFunction).toContain("commerce_fulfillment_tracking_ref_not_active");
    expect(trackingFunction).not.toContain("inventory_consume_reservation_for_fulfillment");
  });

  it("preserves lot and expiry metadata in Omnipack outbound payload evidence", () => {
    expect(omnipackOutboundPayload).toContain("lotNumber");
    expect(omnipackOutboundPayload).toContain("expirationDate");
    expect(omnipackOutboundPayload).toContain('stockTruth: "external_stock_master_with_local_reservations"');
    expect(omnipackOutboundPayload).toContain("shippingDetails");
    expect(omnipackOutboundPayload).toContain("pickUpPoint");
  });

  it("keeps OmniPack credentials on Basic Auth and blocks stage/live without merchant inputs", () => {
    for (const required of [
      "OMNIPACK_USERNAME",
      "OMNIPACK_PASSWORD",
      "OMNIPACK_BASE_URL",
      "OMNIPACK_ENV",
      "OMNIPACK_WEBHOOK_TOKEN",
    ]) {
      expect(omnipackMapper).toContain(required);
      expect(omnipackDocs).toContain(required);
    }

    expect(omnipackMapper).not.toContain("OMNIPACK_API_TOKEN");
    expect(omnipackMapper).not.toContain("OMNIPACK_WAREHOUSE_ID");
    expect(omnipackDocs).toContain("https://api.stage.omnipack.tech");
    expect(omnipackDocs).toContain("https://api.omnipack.tech");
    expect(omnipackDocs).toContain("BLOCKED");
    expect(docsIndex).toContain("COMMERCE_OMNIPACK_INTEGRATION.md");
    expect(docsIndex).toContain("**[evidence/snapshot]**");
    expect(docsIndex).toContain("[archive/COMMERCE_VENDOR_RESEARCH.md](archive/COMMERCE_VENDOR_RESEARCH.md)");
  });

  it("keeps the OmniPack HTTP client out of browser-side src imports", () => {
    const srcFiles = listFiles("src").filter((file) => /\.(ts|tsx)$/.test(file));
    for (const file of srcFiles) {
      expect(read(file)).not.toMatch(/api\/infra\/omnipack\/client|infra\/omnipack\/client/);
    }
  });
});

function extractFunction(name: string): string {
  return extractFunctionFrom(fulfillmentSql, name);
}

function extractFunctionFrom(source: string, name: string): string {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  const rest = source.slice(start);
  return rest.slice(0, rest.indexOf("CREATE OR REPLACE FUNCTION public.", 1));
}

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function listFiles(path: string): string[] {
  const absolutePath = join(process.cwd(), path);
  return readdirSync(absolutePath).flatMap((entry) => {
    const child = join(path, entry);
    const childAbsolute = join(process.cwd(), child);
    return statSync(childAbsolute).isDirectory() ? listFiles(child) : [child];
  });
}
