import type { TFunction } from "i18next";
import {
  type AdminFulfillmentActionPolicy,
  deriveAdminFulfillmentActionPolicy,
} from "@/domains/fulfillment/providerCapabilities";

// Actions that can carry a plain-language "what it does" hint tooltip.
export type HintableAction =
  | "addNote"
  | "hold"
  | "release"
  | "createFulfillment"
  | "updateAddress"
  | "recordLabel"
  | "handOff"
  | "recordTracking"
  | "cancel"
  | "markRefunded";

export interface AdminFulfillmentActionPresentation {
  policy: AdminFulfillmentActionPolicy | null;
  // When true the provider (a 3PL like OmniPack) auto-generates the label and hands the
  // parcel over, so the panel hides the manual recordLabel/handOff buttons and shows a
  // read-only status chip instead. See deriveAdminFulfillmentActionPolicy.
  autoLabelAndHandoff: boolean;
  // createFulfillment label, phrased for the resolved provider role (falls back to the
  // generic label when the order has no resolved provider yet).
  createFulfillmentLabel: string;
  // Short notice shown for auto-dispatch providers explaining that label + hand-off are
  // automatic; null for manual providers.
  autoDispatchNotice: string | null;
  // Read-only chip text that replaces the manual label/hand-off buttons; null otherwise.
  autoMonitorChip: string | null;
  hint: (action: HintableAction) => string;
}

export function buildAdminFulfillmentActionPresentation(
  providerKind: string | null | undefined,
  t: TFunction,
): AdminFulfillmentActionPresentation {
  const policy = deriveAdminFulfillmentActionPolicy(providerKind);
  const autoLabelAndHandoff = policy?.autoLabelAndHandoff ?? false;
  const provider = policy?.displayName ?? "";
  const createFulfillmentLabel = policy
    ? t(`admin:adminOms.actions.createFulfillmentByRole.${policy.role}`, { provider })
    : t("admin:adminOms.actions.createFulfillment");
  return {
    policy,
    autoLabelAndHandoff,
    createFulfillmentLabel,
    autoDispatchNotice: autoLabelAndHandoff ? t("admin:adminOms.actions.autoDispatchNotice", { provider }) : null,
    autoMonitorChip: autoLabelAndHandoff ? t("admin:adminOms.actions.autoLabelChip", { provider }) : null,
    hint: (action) => t(`admin:adminOms.actions.hint.${action}`),
  };
}
