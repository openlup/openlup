import type {
  OmnipackDeliveryKind,
  OmnipackDictionaryBlocker,
  OmnipackMerchantDictionary,
  OmnipackStatusScope,
} from "./merchantDictionary.js";

export interface OmnipackDeliverySelectionInput {
  carrierKind: string;
  serviceCode: string;
  deliveryKind?: OmnipackDeliveryKind;
  pickupPoint?: Record<string, unknown> | null;
}

export function findOmnipackCarrierService(
  dictionary: OmnipackMerchantDictionary,
  carrierKind: string,
  serviceCode: string,
) {
  const carrier = dictionary.carriers.find((candidate) => candidate.kind === carrierKind) ?? null;
  const service = carrier?.services.find((candidate) => candidate.code === serviceCode) ?? null;
  return carrier && service ? { carrier, service } : null;
}

export function findOmnipackSkuProduct(dictionary: OmnipackMerchantDictionary, sku: string) {
  const stageSku = dictionary.stageSkus.find((candidate) => candidate.sku === sku) ?? null;
  const group = stageSku ? dictionary.productGroups.find((candidate) => candidate.code === stageSku.productGroup) ?? null : null;
  return stageSku && group ? { stageSku, group } : null;
}

export function findOmnipackStockSkuClassification(
  dictionary: OmnipackMerchantDictionary,
  sku: string,
) {
  return dictionary.stockSkus.find((candidate) => candidate.sku === sku) ?? null;
}

export function resolveOmnipackDeliverySelection(dictionary: OmnipackMerchantDictionary, input: OmnipackDeliverySelectionInput) {
  const blocked: OmnipackDictionaryBlocker[] = [];
  const found = findOmnipackCarrierService(dictionary, input.carrierKind, input.serviceCode);
  if (!found) {
    return { ok: false as const, blocked: [block(`carriers.${input.carrierKind}.services.${input.serviceCode}`)] };
  }
  if (input.deliveryKind && input.deliveryKind !== found.service.deliveryKind) {
    blocked.push(block(`carriers.${input.carrierKind}.services.${input.serviceCode}.deliveryKind`));
  }
  const semantics = dictionary.pickupPoints[input.carrierKind];
  const pickupPoint = found.service.requiresPickupPoint
    ? normalizePickupPoint(input.carrierKind, semantics, input.pickupPoint, blocked)
    : null;
  if (blocked.length > 0) return { ok: false as const, blocked };
  return {
    ok: true as const,
    providerKind: "omnipack" as const,
    carrierKind: found.carrier.kind,
    carrierCode: found.service.code,
    serviceCode: found.service.code,
    deliveryKind: found.service.deliveryKind,
    requiresPickupPoint: found.service.requiresPickupPoint,
    pickupPoint,
  };
}

export function mapOmnipackDictionaryStatus(dictionary: OmnipackMerchantDictionary, scope: OmnipackStatusScope, providerStatus: string) {
  const mapping = dictionary.statusMappings[scope].find((candidate) => candidate.providerStatus === providerStatus) ?? null;
  if (!mapping) {
    return {
      ok: false as const,
      quarantine: true as const,
      blocked: [block(`statusMappings.${scope}.${providerStatus}`)],
    };
  }
  return { ok: true as const, mapping };
}

function normalizePickupPoint(
  carrierKind: string,
  semantics: OmnipackMerchantDictionary["pickupPoints"][string] | undefined,
  input: Record<string, unknown> | null | undefined,
  blocked: OmnipackDictionaryBlocker[],
): Record<string, string> | null {
  if (!semantics) {
    blocked.push(block(`pickupPoints.${carrierKind}`));
    return null;
  }
  const raw = asRecord(input);
  const normalized: Record<string, string> = {};
  for (const field of semantics.requiredFields) {
    const value = readString(raw[field]);
    if (!value) blocked.push(block(`pickupPoints.${carrierKind}.${field}`));
    else normalized[field] = value;
  }
  return blocked.length === 0 ? normalized : null;
}

function block(target: string): OmnipackDictionaryBlocker {
  return { reason: "merchant_dictionary_invalid_value", target, severity: "BLOCKED" };
}

function readString(input: unknown): string {
  return typeof input === "string" ? input.trim() : "";
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}
