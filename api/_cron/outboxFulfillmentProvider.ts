// Fulfillment-provider composition root for the outbox-dispatch cron.
// The provider REGISTRY + capability/readiness/validation policy now lives in the
// pure domain kernel `server/domains/fulfillment/fulfillmentKernel.ts` (the OSS
// FulfillmentProviderPlugin contract). This file is the COMPOSITION ROOT: it binds
// the impure operations the kernel cannot import (createPort, the OmniPack worker
// entrypoints) onto the kernel descriptors, and keeps the
// cron-specific stage-batch gate + OmniPack credential-config check here. It
// preserves the existing public API while the OmniPack paid-order boundary only
// records the local fulfillment obligation; provider dispatch remains worker-owned.
import {
  type OrderPaidFulfillmentPort,
} from "../../server/domains/commerce/outboxOrderPaidFulfillmentPorts.js";
import {
  createRoutingOrderPaidFulfillmentPort,
} from "../../server/domains/commerce/routingOrderPaidFulfillmentPort.js";
import { createSupabaseOrderPaidFulfillmentPort } from "../../server/adapters/supabase/orderPaidFulfillmentPort.js";
import { createSupabaseOrderFulfillmentProviderKindReader } from "../../server/adapters/supabase/fulfillmentCompositionPorts.js";
import {
  readOmnipackDispatchBatchLimit,
  readOmnipackDispatchMode,
  runOmnipackDispatchWorker,
} from "../../server/domains/fulfillment/omnipackDispatchWorker.js";
import { runOmnipackReconciliationWorker } from "../../server/domains/fulfillment/omnipackReconciliationWorker.js";
import { runOmnipackStockSyncWorker } from "../../server/domains/fulfillment/omnipackStockSyncWorker.js";
import {
  readOmnipackClientConfig,
} from "../../server/infra/omnipack/client.js";
import { OMNIPACK_PRODUCTION_BASE_URL } from "../../server/infra/omnipack/outboundOrderMapper.js";
import { createOmnipackOrderPaidFulfillmentPort } from "../../server/adapters/omnipack/commerceFulfillmentPort.js";
import { buildOmnipackOutboundOrderPayload } from "../../server/_lib/omnipackOutboundOrderPayload.js";
import { withAutoDispatchAccountingInvoiceTrigger } from "../../server/domains/accounting/fulfillmentInvoiceTrigger.js";
import { createSupabaseOrderInvoicePolicyReader } from "../../server/adapters/supabase/orderBuyerCommsPolicyReader.js";
import { createSupabaseAccountingInvoicePort } from "../../server/adapters/supabase/accountingInvoicePort.js";
import {
  createOrderPaidShipmentSpinePort,
  resolveShipmentSpineBinding,
  type CloseableOrderPaidFulfillmentPort,
} from "../../server/runtime/fulfillment/shipmentSpineBinding.js";
import {
  createAccountingPaidOrderDocumentBinding,
  type AccountingPaidOrderDocumentBinding,
} from "../../server/runtime/accounting/accountingRuntime.js";
import { resolveBundleId } from "../../server/domains/platform-runtime/platformKernel.js";
import { readAccountingRuntimeConfig } from "../../server/domains/accounting/accountingRuntimeConfig.js";
import { readAccountingLedgerProviderKind } from "../../server/infra/accounting/providerFactory.js";
import { COMMERCE_ORDER_PAID_EVENT_TYPE } from "../../src/domains/commerce/outboxEventContracts.js";
import {
  FULFILLMENT_PROVIDER_DESCRIPTORS,
  readOmnipackKernelReadiness,
  type FulfillmentProviderEnv,
  type FulfillmentProviderPlugin,
  type FulfillmentProviderReadiness,
} from "../../server/domains/fulfillment/fulfillmentKernel.js";

export type {
  FulfillmentProviderEnv,
  FulfillmentAutoDispatchProviderKind,
  FulfillmentProviderSelectionKind,
  FulfillmentProviderReadiness,
  FulfillmentProviderPlugin,
  FulfillmentProviderType,
  FulfillmentProviderDescriptor,
  CanonicalDeliverySelection,
} from "../../server/domains/fulfillment/fulfillmentKernel.js";
export {
  fulfillmentProviderType,
  validateDeliverySelectionForKind,
  FULFILLMENT_PROVIDER_OPERATIONS_BY_TYPE,
} from "../../server/domains/fulfillment/fulfillmentKernel.js";

type OrderPaidPlugin = FulfillmentProviderPlugin<OrderPaidFulfillmentPort>;

export interface OrderPaidFulfillmentProviderSelection {
  eventType: typeof COMMERCE_ORDER_PAID_EVENT_TYPE;
  providerKind: OrderPaidPlugin["kind"] | "unsupported";
  readiness: FulfillmentProviderReadiness;
  port: OrderPaidFulfillmentPort | null;
}

// Per-kind impure createPort + readReadiness bindings. These are the only pieces
// the kernel cannot own (they reach into server/infra + other domains). Keyed by
// provider kind so each runtime plugin is the kernel descriptor + its bindings.
const CREATE_PORT: Record<Exclude<OrderPaidPlugin["kind"], "dhl">, (client: never, env: FulfillmentProviderEnv) => OrderPaidFulfillmentPort | null> = {
  simulator: (client) => createSupabaseOrderPaidFulfillmentPort(client),
  manual: () => null,
  omnipack: (client) => createOmnipackOrderPaidFulfillmentPort({ client }),
};

// OmniPack readiness = the kernel-pure readiness (dispatch enabled, stage batch
// gate) PLUS the infra credential-config check, which can only run here. Both
// `stage` and `live` require a fully-configured provider client (real creds); a
// `live` dispatch additionally MUST target the production OmniPack environment and
// its canonical production base URL, so a live customer shipment can never fire
// against stage creds or a stray host. `shadow` uses no provider client, so it
// needs neither check.
function readOmnipackComposedReadiness(env: FulfillmentProviderEnv): FulfillmentProviderReadiness {
  const kernel = readOmnipackKernelReadiness(env);
  if (!kernel.ok) return kernel;
  const mode = readOmnipackDispatchMode(env);
  if (mode === "shadow") return { ok: true };
  const clientConfig = readOmnipackClientConfig(env);
  if (!clientConfig) return { ok: false, error: "omnipack_provider_not_configured" };
  if (
    mode === "live" &&
    !(env.OMNIPACK_ENV === "production" && clientConfig.baseUrl === OMNIPACK_PRODUCTION_BASE_URL)
  ) {
    return { ok: false, error: "omnipack_provider_not_configured" };
  }
  return { ok: true };
}

// Wires the existing OmniPack workers + outbound payload builder into the plugin
// operation slots so the 3PL plugin exposes its full lifecycle surface. The
// dispatch worker invokes provider execution separately; the paid-order outbox
// createPort stops after recording the local fulfillment obligation.
const OMNIPACK_OPERATIONS: Pick<OrderPaidPlugin, "buildOutboundOrder" | "dispatch" | "reconcile" | "syncStock"> = {
  buildOutboundOrder: (input) => buildOmnipackOutboundOrderPayload(input as Parameters<typeof buildOmnipackOutboundOrderPayload>[0]),
  dispatch: (input) => runOmnipackDispatchWorker(input as Parameters<typeof runOmnipackDispatchWorker>[0]),
  reconcile: (input) => runOmnipackReconciliationWorker(input as Parameters<typeof runOmnipackReconciliationWorker>[0]),
  syncStock: (input) => runOmnipackStockSyncWorker(input as Parameters<typeof runOmnipackStockSyncWorker>[0]),
};

const RUNTIME_PLUGINS: readonly OrderPaidPlugin[] = FULFILLMENT_PROVIDER_DESCRIPTORS.map((d) => {
  const readReadiness = d.kind === "omnipack" ? readOmnipackComposedReadiness : d.readReadiness;
  const operations = d.kind === "omnipack" ? OMNIPACK_OPERATIONS : {};
  if (d.kind === "dhl") return { ...d, readReadiness, ...operations };
  return { ...d, readReadiness, createPort: CREATE_PORT[d.kind], ...operations };
});

const OMNIPACK_PLUGIN = RUNTIME_PLUGINS.find((p) => p.kind === "omnipack")!;

export function listFulfillmentProviderPlugins(): readonly OrderPaidPlugin[] {
  return RUNTIME_PLUGINS;
}

export function resolveFulfillmentProviderPlugin(env: FulfillmentProviderEnv): OrderPaidPlugin | null {
  const value = env.COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER?.trim().toLowerCase();
  for (const plugin of RUNTIME_PLUGINS) {
    if (plugin.kind === "dhl") continue;
    if (plugin.aliases.includes(value ?? "")) return plugin;
  }
  return null;
}

export function readFulfillmentProviderReadiness(env: FulfillmentProviderEnv): FulfillmentProviderReadiness {
  return resolveFulfillmentProviderPlugin(env)?.readReadiness(env) ?? {
    ok: false,
    error: "fulfillment_provider_not_supported",
  };
}

// Recording an OmniPack obligation is a local DB commitment. Provider dispatch
// readiness belongs exclusively to the scheduled writer and must not block the
// paid-event transaction when credentials or outbound dispatch are disabled.
export function readOrderPaidFulfillmentReadiness(env: FulfillmentProviderEnv): FulfillmentProviderReadiness {
  const plugin = resolveFulfillmentProviderPlugin(env);
  if (!plugin) return { ok: false, error: "fulfillment_provider_not_supported" };
  return plugin.kind === "omnipack" ? { ok: true } : plugin.readReadiness(env);
}

// Provider-I/O readiness for the standalone dispatch cron. The paid-event path
// deliberately bypasses this gate because it records only a local obligation.
export function readOmnipackDispatchReadiness(env: FulfillmentProviderEnv): FulfillmentProviderReadiness {
  return OMNIPACK_PLUGIN.readReadiness(env);
}

export function createFulfillmentPort(client: never, env: FulfillmentProviderEnv): OrderPaidFulfillmentPort | null {
  return selectOrderPaidFulfillmentProvider(client, env).port;
}

export function selectOrderPaidFulfillmentProvider(
  client: never,
  env: FulfillmentProviderEnv,
): OrderPaidFulfillmentProviderSelection {
  const plugin = resolveFulfillmentProviderPlugin(env);
  if (!plugin) {
    return {
      eventType: COMMERCE_ORDER_PAID_EVENT_TYPE,
      providerKind: "unsupported",
      readiness: { ok: false, error: "fulfillment_provider_not_supported" },
      port: null,
    };
  }

  const readiness = readOrderPaidFulfillmentReadiness(env);
  return {
    eventType: COMMERCE_ORDER_PAID_EVENT_TYPE,
    providerKind: plugin.kind,
    readiness,
    port: readiness.ok ? (plugin.createPort?.(client, env) ?? null) : null,
  };
}

// Composition root for the order-paid fulfillment port used by the outbox cron.
// In paid-trigger mode the accounting wrapper must be outside per-order routing
// so every paid order requests the base invoice regardless of the selected
// fulfillment provider. In handoff-trigger mode the default provider keeps the
// wrapper and OmniPack remains covered by its own shipped/handed_over webhook
// path. Returns undefined when fulfillment is not ready or has no usable port.
export function composeOrderPaidFulfillmentPort(input: {
  client: never;
  env: FulfillmentProviderEnv;
  fulfillmentReady: boolean;
  resolveShipmentSpine?: typeof resolveShipmentSpineBinding;
  resolveAccountingPaidOrderDocument?: typeof createAccountingPaidOrderDocumentBinding;
}): OrderPaidFulfillmentPort | undefined {
  if (!input.fulfillmentReady) return undefined;
  if (resolveBundleId(input.env) === "node-postgres") {
    const resolved = (input.resolveShipmentSpine ?? resolveShipmentSpineBinding)(input.env, {
      requiredProviderType: "simulator",
    });
    if (!resolved.binding) return undefined;
    const direct = createOrderPaidShipmentSpinePort(resolved.binding);
    const accountingConfig = readAccountingRuntimeConfig(input.env);
    if (!accountingConfig.requestEnabled) {
      void direct.close();
      return undefined;
    }
    const accounting = (input.resolveAccountingPaidOrderDocument
      ?? createAccountingPaidOrderDocumentBinding)(input.env);
    if (!accounting) {
      void direct.close();
      return undefined;
    }
    return withDirectPaidOrderAccounting(direct, accounting, {
      issueTrigger: accountingConfig.issueTrigger,
      providerKind: readAccountingLedgerProviderKind(input.env),
    });
  }
  const base = selectOrderPaidFulfillmentProvider(input.client, input.env).port ?? undefined;
  if (!base) return undefined;
  const accountingConfig = readAccountingRuntimeConfig(input.env);
  const accountingOptions = {
    accountingPort: createSupabaseAccountingInvoicePort(input.client),
    providerKind: readAccountingLedgerProviderKind(input.env),
    issueTrigger: accountingConfig.issueTrigger,
    // B6: a `suppress`/`channel_issues` channel gets no issue request from here.
    invoicePolicyReader: createSupabaseOrderInvoicePolicyReader(input.client as never),
  } as const;
  const fallback = accountingConfig.requestEnabled && accountingConfig.issueTrigger === "handoff"
    ? withAutoDispatchAccountingInvoiceTrigger(base, { ...accountingOptions })
    : base;
  const routed = wrapWithOmnipackOrderRouting(input.client, input.env, fallback);
  return accountingConfig.requestEnabled && accountingConfig.issueTrigger === "paid"
    ? withAutoDispatchAccountingInvoiceTrigger(routed, { ...accountingOptions })
    : routed;
}

function withDirectPaidOrderAccounting(
  fulfillment: CloseableOrderPaidFulfillmentPort,
  accounting: AccountingPaidOrderDocumentBinding,
  options: { issueTrigger: "handoff" | "paid"; providerKind: string },
): CloseableOrderPaidFulfillmentPort {
  const requestDocument = (orderId: string, phase: "paid" | "handoff") =>
    accounting.requestInvoiceIssueFromPaidOrder({
      idempotencyKey: `order-paid-dispatch:${orderId}:accounting-invoice-${phase}`,
      orderId,
      providerKind: options.providerKind,
    });
  return {
    async ensureFulfilledFromPaidOrder(input) {
      if (options.issueTrigger === "paid") await requestDocument(input.orderUuid, "paid");
      const result = await fulfillment.ensureFulfilledFromPaidOrder(input);
      if (options.issueTrigger === "handoff" && result.kind === "completed") {
        await requestDocument(input.orderUuid, "handoff");
      }
      return result;
    },
    async close() {
      await Promise.all([fulfillment.close(), accounting.close()]);
    },
  };
}

// Wraps the default port so orders whose customer chose an OmniPack delivery
// (selectedDelivery.providerKind = "omnipack") dispatch through OmniPack, while
// every other order stays on the default `base` port. When OmniPack is selected
// but not ready, the wrapper still installs the router with no OmniPack route so
// that selected orders never fall through to the simulator. Provider dispatch
// readiness is intentionally irrelevant here because this route only records
// the local obligation. Returns `base` unchanged only when the default provider
// is already OmniPack.
export function wrapWithOmnipackOrderRouting(
  client: never,
  env: FulfillmentProviderEnv,
  base: OrderPaidFulfillmentPort,
): OrderPaidFulfillmentPort {
  if (resolveFulfillmentProviderPlugin(env)?.kind === "omnipack") return base;
  const omnipackPort = OMNIPACK_PLUGIN.createPort?.(client, env) ?? null;
  return createRoutingOrderPaidFulfillmentPort({
    reader: createSupabaseOrderFulfillmentProviderKindReader(client as never),
    routes: omnipackPort ? { omnipack: omnipackPort } : {},
    failClosedProviderKinds: ["omnipack"],
    failClosedReasons: {
      omnipack: "omnipack_selected_but_port_unavailable",
    },
    fallback: base,
  });
}
