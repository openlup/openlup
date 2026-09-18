import {
  KNOWN_OMNIPACK_PACKAGING_SKUS,
  readOmnipackStockSkus,
  type OmnipackInventoryClass,
  type OmnipackStockSku,
} from "./merchantDictionaryStock.js";
export type { OmnipackInventoryClass } from "./merchantDictionaryStock.js";

export type OmnipackDictionaryBlocker = {
  reason: "merchant_dictionary_section_incomplete" | "merchant_dictionary_invalid_value";
  target: string;
  severity: "BLOCKED";
};

export type OmnipackDeliveryKind = "courier" | "parcel-locker";
export type OmnipackStatusScope = "orders" | "fulfilments" | "shipments" | "subStatuses";
// Layer B vocabulary, written once (it used to appear twice here). This boundary
// may not import src/domains, so the canon link is a conformance assertion.
export const LAYER_B_LOCAL_STATUSES = ["provider_received", "picking", "packed", "in_transit", "delivered", "cancelled", "exception"] as const;
export type OmnipackDictionaryLocalStatus = (typeof LAYER_B_LOCAL_STATUSES)[number];

export interface OmnipackStatusMapping {
  providerStatus: string;
  localStatus: OmnipackDictionaryLocalStatus;
  timelineEvent: string;
  customerVisible: boolean;
  terminal: boolean;
  quarantine: boolean;
}

export interface OmnipackMerchantDictionarySections {
  productGroups: boolean;
  carrierServices: boolean;
  pickupPointSemantics: boolean;
  allowedStatuses: boolean;
  stageSkus: boolean;
}

export interface OmnipackMerchantDictionaryValidation {
  ok: boolean;
  sections: OmnipackMerchantDictionarySections;
  blocked: OmnipackDictionaryBlocker[];
  dictionary: OmnipackMerchantDictionary | null;
}

export interface OmnipackMerchantDictionary {
  stockSkus: OmnipackStockSku[];
  productGroups: Array<{ code: string; description: string | null; appliesToSkus: string[] }>;
  carriers: Array<{
    kind: string;
    code: string;
    services: Array<{ code: string; deliveryKind: OmnipackDeliveryKind; requiresPickupPoint: boolean }>;
  }>;
  pickupPoints: Record<string, { requiresPointId: boolean; requiredFields: string[]; normalization: string | null }>;
  statuses: {
    orders: string[];
    fulfilments: string[];
    shipments: string[];
    subStatuses: string[];
  };
  statusMappings: Record<OmnipackStatusScope, OmnipackStatusMapping[]>;
  stageSkus: Array<{
    sku: string;
    ean: string | null;
    productGroup: string;
    stockedQuantity: number;
    pack: { weightGrams: number; lengthMm: number; widthMm: number; heightMm: number } | null;
  }>;
}

export function validateOmnipackMerchantDictionary(input: unknown): OmnipackMerchantDictionaryValidation {
  const source = asRecord(input);
  const productGroups = readProductGroups(source.productGroups);
  const carriers = readCarriers(source.carriers);
  const pickupPoints = readPickupPoints(source.pickupPoints);
  const statuses = readStatuses(source.statuses);
  const statusMappings = readStatusMappings(source.statusMappings);
  const stageSkus = readStageSkus(source.stageSkus);
  const { stockSkus, blockers: stockSkuBlockers } = readOmnipackStockSkus(source.stockSkus, stageSkus);
  const dictionary: OmnipackMerchantDictionary = { stockSkus, productGroups, carriers, pickupPoints, statuses, statusMappings, stageSkus };
  const blocked: OmnipackDictionaryBlocker[] = [...stockSkuBlockers];
  const sections = {
    productGroups: productGroups.length > 0,
    carrierServices: carriers.length > 0 && carriers.every((carrier) => carrier.services.length > 0),
    pickupPointSemantics: pickupPointSemanticsComplete(dictionary),
    allowedStatuses: statuses.orders.length > 0 && statuses.fulfilments.length > 0 && statuses.shipments.length > 0 && statusMappingsComplete(dictionary),
    stageSkus: stageSkus.length > 0,
  };

  for (const [section, passed] of Object.entries(sections)) {
    if (!passed) blocked.push(block("merchant_dictionary_section_incomplete", section));
  }
  blocked.push(...validateDictionaryConsistency(dictionary));

  return { ok: blocked.length === 0, sections, blocked, dictionary: blocked.length === 0 ? dictionary : null };
}

function validateDictionaryConsistency(dictionary: OmnipackMerchantDictionary): OmnipackDictionaryBlocker[] {
  const blocked: OmnipackDictionaryBlocker[] = [];
  const productGroupCodes = new Set(dictionary.productGroups.map((group) => group.code));
  const stageSkuCodes = new Set(dictionary.stageSkus.map((stageSku) => stageSku.sku));
  const stockSkuClasses = new Map<string, OmnipackInventoryClass>();
  const carrierKinds = new Set<string>();
  const carrierCodes = new Set<string>();
  const serviceCodes = new Set<string>();

  for (const stockSku of dictionary.stockSkus) {
    if (stockSkuClasses.has(stockSku.sku)) {
      blocked.push(block("merchant_dictionary_invalid_value", `stockSkus.${stockSku.sku}`));
    }
    stockSkuClasses.set(stockSku.sku, stockSku.inventoryClass);
  }
  for (const sku of KNOWN_OMNIPACK_PACKAGING_SKUS) {
    if (stockSkuClasses.get(sku) !== "packaging") {
      blocked.push(block("merchant_dictionary_invalid_value", `stockSkus.${sku}.inventoryClass`));
    }
  }

  for (const group of dictionary.productGroups) {
    for (const sku of group.appliesToSkus) {
      if (!stageSkuCodes.has(sku)) blocked.push(block("merchant_dictionary_invalid_value", `productGroups.${group.code}.appliesToSkus`));
    }
  }

  for (const stageSku of dictionary.stageSkus) {
    if (!productGroupCodes.has(stageSku.productGroup)) {
      blocked.push(block("merchant_dictionary_invalid_value", `stageSkus.${stageSku.sku}.productGroup`));
    }
    // EAN is no longer required here: catalog_sku_eans (packs) is the EAN source of truth.
    // The dictionary still owns the product group + pack dimensions.
    if (!stageSku.pack) blocked.push(block("merchant_dictionary_invalid_value", `stageSkus.${stageSku.sku}.pack`));
    if (stockSkuClasses.get(stageSku.sku) !== "sellable") {
      blocked.push(block("merchant_dictionary_invalid_value", `stageSkus.${stageSku.sku}.inventoryClass`));
    }
  }

  for (const carrier of dictionary.carriers) {
    if (carrierKinds.has(carrier.kind)) blocked.push(block("merchant_dictionary_invalid_value", `carriers.${carrier.kind}`));
    if (carrierCodes.has(carrier.code)) blocked.push(block("merchant_dictionary_invalid_value", `carriers.${carrier.kind}.code`));
    carrierKinds.add(carrier.kind);
    carrierCodes.add(carrier.code);
    for (const service of carrier.services) {
      if (serviceCodes.has(service.code)) blocked.push(block("merchant_dictionary_invalid_value", `carriers.${carrier.kind}.services.${service.code}`));
      serviceCodes.add(service.code);
      if (service.deliveryKind === "parcel-locker" && !service.requiresPickupPoint) {
        blocked.push(block("merchant_dictionary_invalid_value", `carriers.${carrier.kind}.services.${service.code}.requiresPickupPoint`));
      }
      if (service.requiresPickupPoint && !dictionary.pickupPoints[carrier.kind]?.requiresPointId) {
        blocked.push(block("merchant_dictionary_invalid_value", `pickupPoints.${carrier.kind}`));
      }
    }
  }

  blocked.push(...validateStatusMappings(dictionary));
  return blocked;
}

function pickupPointSemanticsComplete(dictionary: OmnipackMerchantDictionary): boolean {
  const pickupCarrierKinds = dictionary.carriers
    .filter((carrier) => carrier.services.some((service) => service.requiresPickupPoint || service.deliveryKind === "parcel-locker"))
    .map((carrier) => carrier.kind);
  if (pickupCarrierKinds.length === 0) return true;
  return pickupCarrierKinds.every((kind) => {
    const semantics = dictionary.pickupPoints[kind];
    return semantics?.requiresPointId === true && semantics.requiredFields.length > 0;
  });
}

function readProductGroups(input: unknown): OmnipackMerchantDictionary["productGroups"] {
  return readArray(input).map(asRecord).map((row) => ({
    code: readString(row.code),
    description: readNullableString(row.description),
    appliesToSkus: readStringArray(row.appliesToSkus),
  })).filter((row) => row.code);
}

function readCarriers(input: unknown): OmnipackMerchantDictionary["carriers"] {
  return readArray(input).map(asRecord).map((row) => ({
    kind: readString(row.kind),
    code: readString(row.code),
    services: readArray(row.services).map(asRecord).map((service) => ({
      code: readString(service.code),
      deliveryKind: readDeliveryKind(service.deliveryKind),
      requiresPickupPoint: service.requiresPickupPoint === true,
    })).filter((service) => service.code && service.deliveryKind),
  })).filter((row) => row.kind && row.code);
}

function readPickupPoints(input: unknown): OmnipackMerchantDictionary["pickupPoints"] {
  return Object.fromEntries(Object.entries(asRecord(input)).map(([kind, raw]) => {
    const row = asRecord(raw);
    return [kind, {
      requiresPointId: row.requiresPointId === true,
      requiredFields: readStringArray(row.requiredFields),
      normalization: readNullableString(row.normalization),
    }];
  }));
}

function readStatuses(input: unknown): OmnipackMerchantDictionary["statuses"] {
  const row = asRecord(input);
  return {
    orders: readStringArray(row.orders),
    fulfilments: readStringArray(row.fulfilments),
    shipments: readStringArray(row.shipments),
    subStatuses: readStringArray(row.subStatuses),
  };
}

function readStatusMappings(input: unknown): OmnipackMerchantDictionary["statusMappings"] {
  const row = asRecord(input);
  return {
    orders: readStatusMappingArray(row.orders),
    fulfilments: readStatusMappingArray(row.fulfilments),
    shipments: readStatusMappingArray(row.shipments),
    subStatuses: readStatusMappingArray(row.subStatuses),
  };
}

function readStatusMappingArray(input: unknown): OmnipackStatusMapping[] {
  return readArray(input).map(asRecord).flatMap((row) => {
    const providerStatus = readString(row.providerStatus);
    const localStatus = readLocalStatus(row.localStatus);
    const timelineEvent = readString(row.timelineEvent);
    if (!providerStatus || !localStatus || !timelineEvent) return [];
    return [{ providerStatus, localStatus, timelineEvent, customerVisible: row.customerVisible === true, terminal: row.terminal === true, quarantine: row.quarantine === true }];
  });
}

function readStageSkus(input: unknown): OmnipackMerchantDictionary["stageSkus"] {
  return readArray(input).map(asRecord).map((row) => ({
    sku: readString(row.sku),
    ean: readNullableString(row.ean),
    productGroup: readString(row.productGroup),
    stockedQuantity: readPositiveInteger(row.stockedQuantity),
    pack: readPack(row.pack),
  })).filter((row) => row.sku && row.productGroup && row.stockedQuantity > 0);
}

function readPack(input: unknown): OmnipackMerchantDictionary["stageSkus"][number]["pack"] {
  const row = asRecord(input);
  const pack = {
    weightGrams: readPositiveInteger(row.weightGrams),
    lengthMm: readPositiveInteger(row.lengthMm),
    widthMm: readPositiveInteger(row.widthMm),
    heightMm: readPositiveInteger(row.heightMm),
  };
  return Object.values(pack).every((value) => value > 0) ? pack : null;
}

function readDeliveryKind(input: unknown): OmnipackDeliveryKind {
  return input === "courier" || input === "parcel-locker" ? input : "courier";
}

function readLocalStatus(input: unknown): OmnipackDictionaryLocalStatus | "" {
  return typeof input === "string" && LOCAL_STATUSES.has(input) ? input as OmnipackDictionaryLocalStatus : "";
}

function statusMappingsComplete(dictionary: OmnipackMerchantDictionary): boolean {
  return STATUS_SCOPES.every((scope) => {
    if (dictionary.statuses[scope].length === 0 && scope === "subStatuses") return true;
    const mapped = new Set(dictionary.statusMappings[scope].map((mapping) => mapping.providerStatus));
    return dictionary.statuses[scope].every((status) => mapped.has(status));
  });
}

function validateStatusMappings(dictionary: OmnipackMerchantDictionary): OmnipackDictionaryBlocker[] {
  const blocked: OmnipackDictionaryBlocker[] = [];
  for (const scope of STATUS_SCOPES) {
    const allowed = new Set(dictionary.statuses[scope]);
    const seen = new Set<string>();
    for (const mapping of dictionary.statusMappings[scope]) {
      const target = `statusMappings.${scope}.${mapping.providerStatus}`;
      if (seen.has(mapping.providerStatus)) blocked.push(block("merchant_dictionary_invalid_value", target));
      if (!allowed.has(mapping.providerStatus)) blocked.push(block("merchant_dictionary_invalid_value", target));
      seen.add(mapping.providerStatus);
    }
    for (const status of allowed) {
      if (!seen.has(status)) blocked.push(block("merchant_dictionary_invalid_value", `statusMappings.${scope}.${status}`));
    }
  }
  return blocked;
}

function block(reason: OmnipackDictionaryBlocker["reason"], target: string): OmnipackDictionaryBlocker {
  return { reason, target, severity: "BLOCKED" };
}

function readArray(input: unknown): unknown[] { return Array.isArray(input) ? input : []; }
function readStringArray(input: unknown): string[] { return readArray(input).map(readString).filter(Boolean); }
function readString(input: unknown): string { return typeof input === "string" ? input.trim() : ""; }
function readNullableString(input: unknown): string | null {
  const value = readString(input);
  return value || null;
}
function readPositiveInteger(input: unknown): number { return Number.isInteger(input) && Number(input) > 0 ? Number(input) : 0; }
function asRecord(input: unknown): Record<string, unknown> { return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {}; }

const STATUS_SCOPES = ["orders", "fulfilments", "shipments", "subStatuses"] as const;
const LOCAL_STATUSES = new Set<string>(LAYER_B_LOCAL_STATUSES);
