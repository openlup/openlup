import { buildCheckoutInvoiceBuyerSnapshot as build } from "@openlup/platform/commerce/server";
import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import { invoiceBuyerSnapshotSchema, type CheckoutInvoicePreference } from "../../../src/domains/commerce/checkoutContracts.js";
export function buildCheckoutInvoiceBuyerSnapshot(intent: ConfiguratorIntent, preference: CheckoutInvoicePreference) { return build(intent, preference, invoiceBuyerSnapshotSchema); }
