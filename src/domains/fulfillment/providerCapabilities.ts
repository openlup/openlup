export const FULFILLMENT_PROVIDER_CAPABILITY_KEYS = [
  "autoDispatch",
  "stockEvidence",
  "trackingEvidence",
  "cancel",
  "pickupPoint",
  "labelCreation",
  "courierPickup",
] as const;

export type FulfillmentProviderCapabilityKey = (typeof FULFILLMENT_PROVIDER_CAPABILITY_KEYS)[number];
export type FulfillmentProviderCapabilityMap = Record<FulfillmentProviderCapabilityKey, boolean>;
export type FulfillmentProviderKind = "simulator" | "manual" | "dhl" | "omnipack";
export type FulfillmentProviderStockAuthority =
  | "local_atp"
  | "external_stock_master_with_local_reservations";

export interface FulfillmentProviderCapabilityProfile {
  kind: FulfillmentProviderKind;
  displayName: string;
  role: "simulator" | "manual" | "direct_carrier" | "third_party_logistics";
  capabilities: FulfillmentProviderCapabilityMap;
  actionPolicy: {
    providerSpecificAdminActions: boolean;
    genericAdminActions: boolean;
    mutationSurface: "none" | "local_only" | "provider_adapter";
  };
  stockAuthority: FulfillmentProviderStockAuthority;
  // Notification-ownership policy (W6, folded into the kernel capability map in W8):
  // when true the carrier/3PL owns the customer "delivered" notice, so WE suppress our
  // own delivered email rather than duplicate it. We still own order-paid, invoice,
  // exception, and the one branded "shipped" (dispatched) email for every provider.
  ownsDeliveredNotification: boolean;
}

const CAPABILITIES = {
  simulator: {
    kind: "simulator",
    displayName: "Simulator",
    role: "simulator",
    capabilities: {
      autoDispatch: true,
      stockEvidence: false,
      trackingEvidence: true,
      cancel: false,
      pickupPoint: false,
      labelCreation: true,
      courierPickup: false,
    },
    actionPolicy: {
      providerSpecificAdminActions: false,
      genericAdminActions: true,
      mutationSurface: "local_only",
    },
    stockAuthority: "local_atp",
    ownsDeliveredNotification: false,
  },
  manual: {
    kind: "manual",
    displayName: "Manual",
    role: "manual",
    capabilities: {
      autoDispatch: false,
      stockEvidence: false,
      trackingEvidence: true,
      cancel: false,
      pickupPoint: false,
      labelCreation: false,
      courierPickup: false,
    },
    actionPolicy: {
      providerSpecificAdminActions: false,
      genericAdminActions: true,
      mutationSurface: "local_only",
    },
    stockAuthority: "local_atp",
    ownsDeliveredNotification: false,
  },
  // Dormant direct-carrier emergency fallback. Production routes every courier
  // through the fulfilment-house provider below, including this carrier's own
  // parcels: they ship as a fulfilment-house carrier/service entry (see the
  // courier options declared in `src/domains/shipping/deliverySelectionContracts.ts`).
  // The direct path here is reached only behind the direct-only delivery flag,
  // which is default off. Kept deliberately per PR 937 as the OSS direct-carrier
  // reference example plus an emergency path off the fulfilment house. The
  // capabilities below describe that fallback runtime, not the live route.
  dhl: {
    kind: "dhl",
    displayName: "DHL",
    role: "direct_carrier",
    capabilities: {
      autoDispatch: true,
      stockEvidence: false,
      trackingEvidence: true,
      cancel: false,
      pickupPoint: false,
      labelCreation: true,
      courierPickup: true,
    },
    actionPolicy: {
      providerSpecificAdminActions: true,
      genericAdminActions: true,
      mutationSurface: "provider_adapter",
    },
    stockAuthority: "local_atp",
    ownsDeliveredNotification: false,
  },
  omnipack: {
    kind: "omnipack",
    displayName: "OmniPack",
    role: "third_party_logistics",
    capabilities: {
      autoDispatch: true,
      stockEvidence: true,
      trackingEvidence: true,
      cancel: false,
      pickupPoint: true,
      labelCreation: false,
      courierPickup: false,
    },
    actionPolicy: {
      providerSpecificAdminActions: false,
      genericAdminActions: true,
      mutationSurface: "provider_adapter",
    },
    stockAuthority: "external_stock_master_with_local_reservations",
    // The carrier (via OmniPack) sends the customer "delivered" notice; we suppress ours.
    // Owner decision 2026-09-14: the carrier's "delivered" notice is not a
    // substitute for ours, which carries the getting-started guide. Both go out.
    ownsDeliveredNotification: false,
  },
} as const satisfies Record<FulfillmentProviderKind, FulfillmentProviderCapabilityProfile>;

export const FULFILLMENT_PROVIDER_CAPABILITIES: Readonly<Record<FulfillmentProviderKind, FulfillmentProviderCapabilityProfile>> = CAPABILITIES;

export function normalizeFulfillmentProviderKind(value: string | null | undefined): FulfillmentProviderKind | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "hidden_preview_fulfillment") return "simulator";
  if (normalized in CAPABILITIES) return normalized as FulfillmentProviderKind;
  return null;
}

export function getFulfillmentProviderCapabilityProfile(
  value: string | null | undefined,
): FulfillmentProviderCapabilityProfile | null {
  const kind = normalizeFulfillmentProviderKind(value);
  return kind ? CAPABILITIES[kind] : null;
}

export function listFulfillmentProviderCapabilityProfiles(): readonly FulfillmentProviderCapabilityProfile[] {
  return [CAPABILITIES.simulator, CAPABILITIES.manual, CAPABILITIES.dhl, CAPABILITIES.omnipack];
}

// W6 email-ownership policy, read from the capability map: does the carrier/3PL own
// the customer "delivered" notice (so WE suppress our own delivered email)? Unknown
// providers default to false (we keep ownership) — fail-safe toward sending ours.
export function providerOwnsDeliveredNotification(value: string | null | undefined): boolean {
  return getFulfillmentProviderCapabilityProfile(value)?.ownsDeliveredNotification ?? false;
}

// Admin OMS action policy, derived purely from the capability map — the admin "Akcje"
// panel renders from this instead of assuming a single (label-based) provider shape.
export interface AdminFulfillmentActionPolicy {
  role: FulfillmentProviderCapabilityProfile["role"];
  displayName: string;
  // When true the provider auto-generates the shipping label and hands the parcel over
  // downstream (a 3PL like OmniPack), so the manual `recordLabel`/`handOff` buttons are
  // not the operator's job — the panel shows a read-only status instead. Derived as
  // `autoDispatch && !labelCreation`, which across the registered providers is true ONLY
  // for OmniPack: simulator/dhl are `auto+label` and manual is `!auto+!label`, so the
  // hidden-preview provider (→ simulator) and every manual chain keep their buttons.
  autoLabelAndHandoff: boolean;
}

export function deriveAdminFulfillmentActionPolicy(
  value: string | null | undefined,
): AdminFulfillmentActionPolicy | null {
  const profile = getFulfillmentProviderCapabilityProfile(value);
  if (!profile) return null;
  return {
    role: profile.role,
    displayName: profile.displayName,
    autoLabelAndHandoff: profile.capabilities.autoDispatch && !profile.capabilities.labelCreation,
  };
}
