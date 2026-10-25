export type { OmsFulfillmentProviderStockCurrentRow,OmsInboundProviderEventRow } from "@openlup/platform/commerce/contracts";
import { buildOmsFulfillmentDebug as buildNeutral } from "@openlup/platform/commerce";
import { referenceOmsProjections } from "./omsReferenceBinding.js";
export function buildOmsFulfillmentDebug(input: Omit<Parameters<typeof buildNeutral>[0], "providerDispatchRefs" | "providerStatusEvidence"> & { omnipackDispatchRefs: Parameters<typeof buildNeutral>[0]["providerDispatchRefs"]; omnipackStatusEvidence: Parameters<typeof buildNeutral>[0]["providerStatusEvidence"] }) { return buildNeutral({ ...input, providerDispatchRefs: input.omnipackDispatchRefs, providerStatusEvidence: input.omnipackStatusEvidence, projections: referenceOmsProjections }); }

export function referenceUsesExternalStock(kind: string | null): boolean { return kind === "omnipack"; }
export function referenceDispatchStepLabel(): string { return "OmniPack dispatch"; }
export function referenceDebugSummary(action: ReturnType<typeof buildNeutral>["nextAction"]): string { return {
 wait: "Proces idzie dalej; monitoruj kolejny event.", create_fulfillment: "Utwórz fulfillment order.", retry_dispatch: "Sprawdź lub ponów dispatch do OmniPack.", reconcile: "Uruchom reconciliation, żeby odtworzyć tracking/status.", review_payment: "Najpierw wyjaśnij płatność.", review_stock: "Najpierw wyjaśnij rezerwację stocku.", review_provider: "Sprawdź provider evidence lub skontaktuj OmniPack.", contact_support: "Eskaluj do wsparcia technicznego.",
 }[action]; }
