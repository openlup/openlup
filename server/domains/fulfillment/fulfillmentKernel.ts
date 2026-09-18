// Fulfillment-provider kernel: the canonical, provider-agnostic registry that
// describes every fulfillment provider as a typed plugin. This is the OSS
// reference contract — OmniPack is the canonical 3PL plugin, DHL the canonical
// direct-carrier plugin, simulator/manual the self-fulfillment/test references.
//
// PURE DOMAIN MODULE: it never imports server/infra/* or another domain's
// internals (architecture boundary). The composition root
// (api/_cron/outboxFulfillmentProvider.ts) binds the impure operations
// (createPort, the provider HTTP client, the worker entrypoints) onto these
// descriptors and keeps the cron-specific stage-batch gate + infra config check.
//
// THREE-LAYER INVARIANT (enforced in types + tests): the customer's delivery
// CHOICE, the FULFILLMENT PROVIDER, and the CARRIER+SERVICE are three separate
// layers. The provider is NEVER inferred from the carrier — only an explicit
// `selectedDelivery.providerKind` selects a provider. `validateDeliverySelection`
// reads providerKind, never carrierCode, to decide the provider.

import {
  FULFILLMENT_PROVIDER_CAPABILITIES,
  type FulfillmentProviderCapabilityProfile,
  type FulfillmentProviderKind,
} from "../../../src/domains/fulfillment/providerCapabilities.js";
import {
  readOmnipackDispatchBatchLimit,
  readOmnipackDispatchMode,
} from "./omnipackDispatchWorker.js";

export type FulfillmentProviderType = "3pl" | "direct-carrier" | "manual" | "simulator";
export type FulfillmentAutoDispatchProviderKind = FulfillmentProviderKind;
export type FulfillmentProviderSelectionKind = FulfillmentAutoDispatchProviderKind | "unsupported";

export type FulfillmentProviderReadiness = { ok: true } | { ok: false; error: string };
export type DeliverySelectionValidation = { ok: true } | { ok: false; error: string };

export interface FulfillmentProviderEnv {
  [key: string]: string | undefined;
  COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER?: string;
  COMMERCE_OMNIPACK_DISPATCH_BATCH_LIMIT?: string;
  COMMERCE_OMNIPACK_DISPATCH_ENABLED?: string;
  COMMERCE_OMNIPACK_DISPATCH_MODE?: string;
  COMMERCE_OUTBOX_DISPATCH_BATCH_SIZE?: string;
  COMMERCE_OUTBOX_BATCH_SIZE?: string;
  DHL_LIVE_PREVIEW_CONFIRMED?: string;
  DHL_API_USERNAME?: string;
  DHL_API_PASSWORD?: string;
  DHL_ACCOUNT_NUMBER?: string;
  OMNIPACK_BASE_URL?: string;
  OMNIPACK_ENV?: string;
  OMNIPACK_HTTP_TIMEOUT_MS?: string;
  OMNIPACK_PASSWORD?: string;
  OMNIPACK_PROVIDER_ENABLED?: string;
  OMNIPACK_SAFE_READ_RETRIES?: string;
  OMNIPACK_STAGE_BATCH_CONFIRMED?: string;
  OMNIPACK_STAGE_BATCH_MAX_ORDERS?: string;
  OMNIPACK_USERNAME?: string;
  OMNIPACK_WEBHOOK_TOKEN?: string;
}

// The canonical delivery selection — the three layers as separate fields. The
// kernel reads `providerKind` (the fulfillment-provider layer) to pick a provider
// and NEVER reads `carrierCode`/`carrierKind` (the carrier layer) to infer it.
export interface CanonicalDeliverySelection {
  providerKind: string | null;
  carrierKind: string | null;
  carrierCode: string | null;
  serviceCode: string | null;
}

// Which lifecycle operations a provider TYPE supports — the declarative
// architecture truth (not runtime wiring). 3PL = full lifecycle; direct-carrier
// = build + dispatch (carrier owns transit, no stock sync); simulator = dispatch
// only; manual = none (operator-driven, no auto-dispatch).
export interface FulfillmentProviderOperationSupport {
  buildOutboundOrder: boolean;
  dispatch: boolean;
  reconcile: boolean;
  parseWebhook: boolean;
  syncStock: boolean;
}

export const FULFILLMENT_PROVIDER_OPERATIONS_BY_TYPE: Readonly<
  Record<FulfillmentProviderType, FulfillmentProviderOperationSupport>
> = {
  "3pl": { buildOutboundOrder: true, dispatch: true, reconcile: true, parseWebhook: true, syncStock: true },
  "direct-carrier": { buildOutboundOrder: true, dispatch: true, reconcile: false, parseWebhook: false, syncStock: false },
  simulator: { buildOutboundOrder: false, dispatch: true, reconcile: false, parseWebhook: false, syncStock: false },
  manual: { buildOutboundOrder: false, dispatch: false, reconcile: false, parseWebhook: false, syncStock: false },
};

const PROVIDER_TYPE_BY_ROLE: Readonly<
  Record<FulfillmentProviderCapabilityProfile["role"], FulfillmentProviderType>
> = {
  third_party_logistics: "3pl",
  direct_carrier: "direct-carrier",
  manual: "manual",
  simulator: "simulator",
};

export function fulfillmentProviderType(kind: FulfillmentProviderKind): FulfillmentProviderType {
  return PROVIDER_TYPE_BY_ROLE[FULFILLMENT_PROVIDER_CAPABILITIES[kind].role];
}

// Pure descriptor: everything the kernel can know without infra or another
// domain. The composition root extends this into a runtime plugin by binding the
// impure operations below.
export interface FulfillmentProviderDescriptor {
  kind: FulfillmentAutoDispatchProviderKind;
  type: FulfillmentProviderType;
  aliases: readonly string[];
  capabilities: FulfillmentProviderCapabilityProfile;
  operations: FulfillmentProviderOperationSupport;
  /** W6: when true, the carrier/3PL owns the customer "delivered" notice. */
  ownsDeliveredNotification: boolean;
  readReadiness(env: FulfillmentProviderEnv): FulfillmentProviderReadiness;
  validateDeliverySelection(selection: CanonicalDeliverySelection | null): DeliverySelectionValidation;
}

// The OSS plugin contract: a descriptor plus the impure operation slots bound by
// the composition root. Generic over the port/order types so the kernel needs no
// infra imports. The `operations` matrix declares which slots a type fills.
export interface FulfillmentProviderPlugin<TPort = unknown, TOutboundOrder = unknown>
  extends FulfillmentProviderDescriptor {
  createPort?(client: never, env: FulfillmentProviderEnv): TPort | null;
  buildOutboundOrder?(input: unknown): TOutboundOrder;
  dispatch?(input: unknown): Promise<unknown>;
  reconcile?(input: unknown): Promise<unknown>;
  parseWebhook?(raw: unknown): unknown;
  syncStock?(input: unknown): Promise<unknown>;
}

function descriptor(
  kind: FulfillmentAutoDispatchProviderKind,
  aliases: readonly string[],
  readReadiness: (env: FulfillmentProviderEnv) => FulfillmentProviderReadiness,
): FulfillmentProviderDescriptor {
  const capabilities = FULFILLMENT_PROVIDER_CAPABILITIES[kind];
  const type = fulfillmentProviderType(kind);
  return {
    kind,
    type,
    aliases,
    capabilities,
    operations: FULFILLMENT_PROVIDER_OPERATIONS_BY_TYPE[type],
    ownsDeliveredNotification: capabilities.ownsDeliveredNotification,
    readReadiness,
    validateDeliverySelection: (selection) => validateDeliverySelectionForKind(kind, selection),
  };
}

// Provider is chosen ONLY from `providerKind` (never inferred from the carrier).
// OmniPack additionally requires an explicit carrier+service code; a selection
// that names a carrier but no providerKind does NOT validate as any provider.
export function validateDeliverySelectionForKind(
  kind: FulfillmentAutoDispatchProviderKind,
  selection: CanonicalDeliverySelection | null,
): DeliverySelectionValidation {
  const selectedProvider = selection?.providerKind?.trim().toLowerCase() || null;
  if (kind === "omnipack") {
    if (selectedProvider !== "omnipack") {
      return { ok: false, error: "selection_provider_kind_not_omnipack" };
    }
    if (!selection?.carrierCode || !selection?.serviceCode) {
      return { ok: false, error: "omnipack_requires_carrier_and_service_codes" };
    }
    return { ok: true };
  }
  // Non-3PL providers do not consume the OmniPack selection. A selection that
  // explicitly names a DIFFERENT provider is a layer mismatch; absence is fine.
  if (selectedProvider && selectedProvider !== kind) {
    return { ok: false, error: "selection_provider_kind_mismatch" };
  }
  return { ok: true };
}

function dhlReadiness(env: FulfillmentProviderEnv): FulfillmentProviderReadiness {
  if (env.DHL_LIVE_PREVIEW_CONFIRMED !== "true") {
    return { ok: false, error: "dhl_live_preview_confirmation_required" };
  }
  if (!env.DHL_API_USERNAME || !env.DHL_API_PASSWORD || !env.DHL_ACCOUNT_NUMBER) {
    return { ok: false, error: "dhl_env_required" };
  }
  return { ok: true };
}

// OmniPack readiness EXCEPT the infra credential-config check, which lives in the
// composition root (the kernel cannot import server/infra). Covers: dispatch must
// be explicitly enabled; stage requires the controlled batch gate. shadow/live
// with the intent gate passed → { ok: true } here.
//
// Live auto-dispatch carries NO separate feature flag by design:
// COMMERCE_OMNIPACK_DISPATCH_ENABLED is the single intent switch, and the
// real-credentials / production-environment fail-closed for live lives in the
// composition root (`readOmnipackComposedReadiness`) because it needs
// server/infra. The kill-switch is per-deploy `vercel promote` rollback +
// platform_job_controls.omnipack-dispatch enabled=false — not another env flag.
export function readOmnipackKernelReadiness(env: FulfillmentProviderEnv): FulfillmentProviderReadiness {
  if (env.COMMERCE_OMNIPACK_DISPATCH_ENABLED !== "true") {
    return { ok: false, error: "omnipack_dispatch_disabled" };
  }
  if (readOmnipackDispatchMode(env) === "stage") {
    return readOmnipackStageBatchReadiness(env);
  }
  return { ok: true };
}

export function readOmnipackStageBatchReadiness(env: FulfillmentProviderEnv): FulfillmentProviderReadiness {
  const dispatchBatchLimit = parsePositiveInt(env.COMMERCE_OMNIPACK_DISPATCH_BATCH_LIMIT);
  const outboxDispatchBatchSize = parsePositiveInt(env.COMMERCE_OUTBOX_DISPATCH_BATCH_SIZE);
  if (dispatchBatchLimit === 1) {
    if (outboxDispatchBatchSize !== 1) {
      return { ok: false, error: "omnipack_stage_outbox_dispatch_batch_size_must_match_dispatch_batch" };
    }
    return { ok: true };
  }

  if (env.OMNIPACK_STAGE_BATCH_CONFIRMED !== "true") {
    return { ok: false, error: "omnipack_stage_batch_limit_must_be_1" };
  }
  if (dispatchBatchLimit === null || dispatchBatchLimit < 2 || dispatchBatchLimit > 5) {
    return { ok: false, error: "omnipack_stage_batch_limit_must_be_between_2_and_5" };
  }
  if (parsePositiveInt(env.OMNIPACK_STAGE_BATCH_MAX_ORDERS) !== dispatchBatchLimit) {
    return { ok: false, error: "omnipack_stage_batch_max_orders_must_match_dispatch_limit" };
  }
  if (outboxDispatchBatchSize !== dispatchBatchLimit) {
    return { ok: false, error: "omnipack_stage_outbox_dispatch_batch_size_must_match_dispatch_batch" };
  }
  return { ok: true };
}

export function parsePositiveInt(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

// The static descriptor registry. `readReadiness` is the kernel-pure readiness;
// OmniPack's infra credential-config check is composed on top in the cron.
export const FULFILLMENT_PROVIDER_DESCRIPTORS: readonly FulfillmentProviderDescriptor[] = [
  descriptor("simulator", ["", "simulator", "hidden_preview_fulfillment"], () => ({ ok: true })),
  descriptor("manual", ["manual"], () => ({ ok: false, error: "manual_fulfillment_not_auto_dispatchable" })),
  descriptor("dhl", ["dhl"], dhlReadiness),
  descriptor("omnipack", ["omnipack"], readOmnipackKernelReadiness),
];

export function listFulfillmentProviderDescriptors(): readonly FulfillmentProviderDescriptor[] {
  return FULFILLMENT_PROVIDER_DESCRIPTORS;
}

export function resolveFulfillmentProviderDescriptor(
  env: FulfillmentProviderEnv,
): FulfillmentProviderDescriptor | null {
  const value = env.COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER?.trim().toLowerCase();
  for (const candidate of FULFILLMENT_PROVIDER_DESCRIPTORS) {
    if (candidate.aliases.includes(value ?? "")) return candidate;
  }
  return null;
}

export function omnipackDescriptor(): FulfillmentProviderDescriptor {
  // Non-null by construction (the registry always contains omnipack).
  return FULFILLMENT_PROVIDER_DESCRIPTORS.find((d) => d.kind === "omnipack")!;
}
