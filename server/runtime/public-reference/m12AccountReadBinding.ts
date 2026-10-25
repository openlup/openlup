import { createAccountReadFacade } from "@openlup/platform/account-support";
import type { CustomerAccountPort, CustomerOrdersPort } from "../../domains/customers/ports.js";

/** Explicit reference binding; injects existing owners without selecting a graph,
 * constructing providers or supplying application profile/market defaults.
 */
export function createM12AccountReadBinding(ports: {
  account: CustomerAccountPort;
  orders: CustomerOrdersPort;
}) {
  return createAccountReadFacade(ports);
}

import {
  readAccountSnapshot,
  readCustomerOrderSummaries,
  readCustomerOrderDetail,
  createInvoiceAccess
} from "@openlup/platform/account-support";
import type {
  AccountReadSources,
  AccountReadProjectionPolicy,
  CustomerOrderHistoryReadStore,
  CustomerOrderHistoryProjectionPort,
  InvoiceAccessOptions
} from "@openlup/platform/account-support";
import { buildFulfillmentEvidenceSummary } from "../../../src/domains/fulfillment/types.js";
import { formatCustomerOrderReference } from "../../../src/lib/orderRef.js";
import { mapCustomerOrderLines } from "../../domains/customers/customerOrderHistoryMoney.js";

import type { AccountSubscription } from "@openlup/platform/account-support/contracts";
import { canUsePaymentMethodForRenewal } from "../../../src/domains/subscription/contracts.js";
import { withNextCharge } from "../../adapters/supabase/customerAccountStarterNextCharge.js";
import {
  resolveCustomerSubscriptionPaymentMethodStatus,
  type SubscriptionPaymentMethodEvidence
} from "../../adapters/supabase/customerSubscriptionPaymentMethodReadModel.js";

type Row = Record<string, unknown>;
type ReferenceChargeEvidence = Exclude<Parameters<typeof withNextCharge>[1], undefined>;

/** Existing OpenLup policy is selected explicitly; donor divergence remains an adoption-time injection. */
export function m12ReferenceAccountProjection(
  packageSummary: AccountReadProjectionPolicy["packageSummary"]
): AccountReadProjectionPolicy<ReferenceChargeEvidence, SubscriptionPaymentMethodEvidence> {
  return {
    packageSummary,
    withNextCharge,
    canUsePaymentMethodForRenewal,
    paymentMethodStatus: input => resolveCustomerSubscriptionPaymentMethodStatus({
      clientId: input.clientId,
      clientEmail: input.clientEmail,
      subscriptionPaymentMethodKind: typeof input.row.payment_method_kind === "string" ? input.row.payment_method_kind : null,
      subscriptionPaymentMethodRef: typeof input.row.payment_method_ref === "string" ? input.row.payment_method_ref : null,
      paymentEvidence: input.evidence
    })
  };
}

/** Host source attribution and catalogue policy stay outside the package. */
export function m12ReferenceOrderProjection(): CustomerOrderHistoryProjectionPort {
  return {
    automaticHoldSource: "commerce.fulfillment.omnipack_provider_exception",
    automaticReleaseSource: "commerce.fulfillment.omnipack_provider_exception_healed",
    orderReference: formatCustomerOrderReference,
    fulfillmentEvidence: buildFulfillmentEvidenceSummary,
    presentation: {
      display(row) {
        const { title, variantName, productSlug, displayLabel, accentColor } = mapCustomerOrderLines([row], [], "")[0]!;
        return { title, variantName, productSlug, displayLabel, accentColor };
      }
    }
  };
}

export interface M12AccountReadScope<Extension, ChargeEvidence = AccountSubscription["nextCharge"], PaymentEvidence = unknown> {
  /** Must use the authenticated principal's existing owned account reader. */
  client(userId: string): Promise<Row | null>;
  account?: {
    sources: AccountReadSources<Extension, ChargeEvidence, PaymentEvidence>;
    policy: AccountReadProjectionPolicy<ChargeEvidence, PaymentEvidence>
  };
  orders?: CustomerOrderHistoryReadStore;
  invoices?: InvoiceAccessOptions;
  close(): Promise<void>;
}

export interface M12AccountReadSelection<Extension, ChargeEvidence = AccountSubscription["nextCharge"], PaymentEvidence = unknown> {
  enabled?: boolean;
  graph: "managed" | "native";
  /** Presence is explicit selection, including native. No native store is invented. */
  open?: () => Promise<M12AccountReadScope<Extension, ChargeEvidence, PaymentEvidence>>;
}

const hostRequired = () => ({ supported: false, refusalCode: "host_binding_required" } as const);

/** Separate factory leaves R1's null/throw facade unchanged. Import and construction are inert. */
export function createM12AccountReadSelection<Extension, ChargeEvidence, PaymentEvidence>(
  selection: M12AccountReadSelection<Extension, ChargeEvidence, PaymentEvidence>
) {
  async function run<Result>(work: (scope: M12AccountReadScope<Extension, ChargeEvidence, PaymentEvidence>) => Promise<Result>) {
    if (!selection.enabled || !selection.open) return hostRequired();
    const scope = await selection.open();
    try {
      return await work(scope);
    } finally {
      await scope.close();
    }
  }
  return {
    getAccount: (userId: string) => run(async scope => {
      if (!scope.account) return hostRequired();
      const client = await scope.client(userId);
      if (!client) return null;
      return readAccountSnapshot(scope.account.sources, scope.account.policy, client);
    }),
    listOrders: (userId: string, input: { limit: number }) => run(async scope => {
      if (!scope.orders) return hostRequired();
      const client = await scope.client(userId);
      if (!client) return null;
      return readCustomerOrderSummaries(scope.orders, String(client.id), input.limit, m12ReferenceOrderProjection());
    }),
    getOrderDetail: (userId: string, orderId: string) => run(async scope => {
      if (!scope.orders) return hostRequired();
      const client = await scope.client(userId);
      if (!client) return null;
      return readCustomerOrderDetail(scope.orders, String(client.id), orderId, m12ReferenceOrderProjection());
    }),
    history: (userId: string, orderId: string) => run(async scope => {
      const client = await scope.client(userId);
      if (!client) return { kind: "denied" as const };
      return createInvoiceAccess(scope.invoices).history({ accountRef: String(client.id), orderId });
    }),
    download: (userId: string, orderId: string, documentRef: string) => run(async scope => {
      const client = await scope.client(userId);
      if (!client) return { kind: "denied" as const };
      return createInvoiceAccess(scope.invoices).download({ accountRef: String(client.id), orderId, documentRef });
    }),
  };
}
