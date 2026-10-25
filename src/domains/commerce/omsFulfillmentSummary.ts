export { parseTimestampOrZero } from "@openlup/platform/commerce";
export type { OmsFulfillmentOperationRow,OmsFulfillmentOrderRow,OmsProviderDispatchRefRow as OmsOmnipackDispatchRefRow,OmsProviderStatusEvidenceRow as OmsOmnipackStatusEvidenceRow,OmsProviderAttemptRow,OmsReleasedProviderExceptionHoldRow,OmsShipmentExternalRefRow } from "@openlup/platform/commerce/contracts";
import { buildOmsFulfillmentSummary as buildNeutral, deriveOmsCustomerFulfillmentStep as deriveNeutral } from "@openlup/platform/commerce";
import { referenceOmsProjections } from "./omsReferenceBinding.js";
export function buildOmsFulfillmentSummary(input: Omit<Parameters<typeof buildNeutral>[0], "providerDispatchRefs" | "providerStatusEvidence"> & { omnipackDispatchRefs?: Parameters<typeof buildNeutral>[0]["providerDispatchRefs"]; omnipackStatusEvidence?: Parameters<typeof buildNeutral>[0]["providerStatusEvidence"] }) { return buildNeutral({ ...input, providerDispatchRefs: input.omnipackDispatchRefs, providerStatusEvidence: input.omnipackStatusEvidence, projections: referenceOmsProjections }); }
export function deriveOmsCustomerFulfillmentStep(...args: Parameters<typeof deriveNeutral>) { return deriveNeutral(args[0], args[1], args[2], args[3], args[4], args[5], referenceOmsProjections); }

export function referenceDispatchLabel(status: string | null | undefined): string { return status === "created" ? "Wyslane do OmniPack" : status === "failed" ? "Dispatch OmniPack wymaga sprawdzenia" : "Dispatch OmniPack zapisany"; }
