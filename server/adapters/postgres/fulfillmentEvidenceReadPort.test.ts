import { describe, expect, it, vi } from "vitest";
import { createPostgresFulfillmentLowStockEvidencePort } from "./fulfillmentEvidenceReadPort.js";

describe("postgres fulfillment low-stock evidence port", () => {
  it("rejects an empty source key before issuing a query", () => {
    const query = vi.fn();

    expect(() => createPostgresFulfillmentLowStockEvidencePort({ query }, "   ")).toThrow(
      "fulfillment_stock_source_key_required",
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("reads the scoped evidence projection and maps nullable values", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: "evidence-1",
        sku: "opaque-sku",
        threshold_kind: "provider_zero_local_positive",
        severity: "warning",
        status: "open",
        provider_for_sale_quantity: 0,
        local_available_quantity: 4,
        first_seen_at: "2026-08-13T10:00:00.000Z",
        last_seen_at: "2026-08-13T11:00:00.000Z",
        resolved_at: null,
      }] })
      .mockResolvedValueOnce({ rows: [{ count: 1 }] });
    const port = createPostgresFulfillmentLowStockEvidencePort({ query }, " stock-source ");

    await expect(port.getLowStockEvidence({ statusFilter: "open" })).resolves.toEqual({
      statusFilter: "open",
      openCount: 1,
      items: [{
        id: "evidence-1",
        sku: "opaque-sku",
        thresholdKind: "provider_zero_local_positive",
        severity: "warning",
        status: "open",
        providerForSaleQuantity: 0,
        localAvailableQuantity: 4,
        forecastDays: null,
        firstSeenAt: "2026-08-13T10:00:00.000Z",
        lastSeenAt: "2026-08-13T11:00:00.000Z",
        resolvedAt: null,
      }],
    });
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining("fulfillment_stock_evidence"), [
      "stock-source",
      "open",
    ]);
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining("status = 'open'"), [
      "stock-source",
    ]);
  });

  it("uses neutral defaults for malformed optional database values", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: 42,
        sku: 7,
        threshold_kind: "local_below_forecast",
        severity: "critical",
        status: "resolved",
        provider_for_sale_quantity: undefined,
        local_available_quantity: Number.NaN,
        first_seen_at: "",
        last_seen_at: undefined,
        resolved_at: "2026-08-13T12:00:00.000Z",
      }] })
      .mockResolvedValueOnce({ rows: [] });
    const port = createPostgresFulfillmentLowStockEvidencePort({ query }, "source");

    await expect(port.getLowStockEvidence({ statusFilter: "all" })).resolves.toMatchObject({
      statusFilter: "all",
      openCount: 0,
      items: [{
        id: "42",
        sku: "7",
        providerForSaleQuantity: 0,
        localAvailableQuantity: 0,
        firstSeenAt: null,
        lastSeenAt: null,
        resolvedAt: "2026-08-13T12:00:00.000Z",
      }],
    });
  });
});
