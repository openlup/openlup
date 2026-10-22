import type { OmnipackClientConfig } from "../../../src/fulfillment/omnipack/client.js";
import type { OmnipackDispatchCandidate } from "../../../src/fulfillment/omnipack/omnipackDispatchPayload.js";

export const config: OmnipackClientConfig = {
  baseUrl: "https://warehouse.example.test", timeoutMs: 1000, safeReadRetries: 1,
  productPath: "/products", credentials: () => ({ username: "example", password: "placeholder" }),
};
export const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
export function candidate(): OmnipackDispatchCandidate {
  return {
    orderId: "order-1", orderNumber: "ORDER-1",
    deliveryContact: {
      revision: 1, recipientName: "Example Recipient", contactEmail: "recipient@example.test",
      contactPhone: "+12025550123", line1: "123 Example Street", city: "Example City", postalCode: "10001", country: "US",
      selectedDelivery: { providerKind: "omnipack", carrierCode: "EXAMPLE", serviceCode: "EXAMPLE_COURIER", deliveryKind: "courier" },
    },
    lines: [
      { sku: "SKU-B", quantity: 2, productSnapshot: { lotNumber: "  ", expiresAt: "" } },
      { sku: "SKU-A", quantity: 1, productSnapshot: { lotCode: " LOT-1 ", expirationDate: " 2027-01-02 " } },
    ],
  };
}
export const stock = { _embedded: { stockItems: [{ sku: "SKU-A", totalQuantity: 48, forSaleQuantity: 35,
  expireSoonQuantity: 1, faultyQuantity: 2, complaintsQuantity: 3, withheldQuantity: 1,
  packagingQuantity: 2, processingQuantity: 3, unpackingQuantity: 1 }] } };
export const stockEvidence = [{ provider: "omnipack", sku: "SKU-A", totalQuantity: 48, forSaleQuantity: 35,
  reservedOrUnavailableQuantity: 13, stockTruth: "external_stock_master_with_local_reservations" }];
