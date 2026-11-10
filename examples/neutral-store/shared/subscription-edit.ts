import type { PackageEditMoney, SizedEditPolicy } from '@openlup/platform/subscriptions/contracts';
import type { Localized, Product } from './config.ts';

/** Values and synthetic subject data belong to this application. */
export interface SubscriptionEditorConfig {
  minimumBaseUnits: number;
  planDays: readonly number[];
  maximumBaseLines: number;
  maximumAddonLines: number;
  maximumQuantity: number;
  sized: SizedEditPolicy & { preferredSize: number; nominalSizes: readonly number[] };
  subject: { revision: number; dailyNeed: number; currentExclusions: string[]; inheritedExclusions: string[] };
  catalogue: readonly EditorProduct[];
}
export interface EditorProduct extends Product {
  groupKey: string;
  physicalSize: number;
  demandPerUnit: number;
  exclusions: readonly string[];
  isAddon: boolean;
  stockQuantity: number;
}
export interface EditorSubscription {
  subscriptionId: string;
  status: string;
  cadenceDays: number;
  nextCycleAt: string | null;
  editCutoffAt: string | null;
  templateVersion: number;
  compositionConstraint: Record<string, unknown> | null;
  offerVersion: 'classic' | 'sized.v1';
  canEditUpcomingPackage: boolean;
  editBlockedReason: string | null;
  recurringTotal: PackageEditMoney | null;
  lines: { lineId: string; variantId: string; qty: number; isAddon: boolean; sortOrder: number;
    sku: string | null; title: string | null; unitPrice: PackageEditMoney | null; lineSubtotal: PackageEditMoney | null }[];
}
export interface EditorCandidate {
  variantId: string; sku: string; groupId: string; name: Localized;
  isAddon: boolean; sellable: boolean; selectable: boolean;
  physicalSize: number; demandPerUnit: number; sellableNow: number | null;
}

export function assertEditorConfig(config: SubscriptionEditorConfig): void {
  const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
  if (!config || ![config.minimumBaseUnits, config.maximumBaseLines, config.maximumAddonLines,
    config.maximumQuantity, ...config.planDays, config.sized?.preferredSize, ...(config.sized?.nominalSizes ?? [])].every(positive)
    || !config.planDays.length || config.planDays.some(days => days > 90) || config.maximumQuantity > 99
    || !config.subject || !positive(config.subject.dailyNeed) || !positive(config.subject.revision)
    || ![config.subject.currentExclusions, config.subject.inheritedExclusions].every(list => Array.isArray(list) && list.every(key => typeof key === 'string' && key.length > 0))) {
    throw new Error('starter_subscription_configuration_invalid');
  }
  const policy = config.sized;
  if (![policy.minimumCoreUnits, policy.maximumCoreLines, policy.maximumAddonLines, policy.maximumQuantity,
    policy.maximumExclusions, policy.maximumCatalogExclusions, policy.fixedThroughCycle, policy.graduationCycle, ...policy.allowedCadences].every(positive)
    || !policy.allowedCadences.length || policy.allowedCadences.some(days => days > 90)
    || policy.maximumQuantity > 99 || policy.graduationCycle <= policy.fixedThroughCycle
    || policy.portionModes.full.mode === policy.portionModes.reduced.mode
    || !policy.portionModes.full.mode || !policy.portionModes.reduced.mode
    || !(policy.portionModes.full.factor > policy.portionModes.reduced.factor && policy.portionModes.reduced.factor > 0)
    || !Number.isFinite(policy.portionModes.full.factor)
    || config.catalogue.some(product => !product.groupKey || !positive(product.physicalSize) || !positive(product.demandPerUnit)
      || !Number.isSafeInteger(product.stockQuantity) || product.stockQuantity < 0 || product.stockQuantity > 2147483647
      || !Array.isArray(product.exclusions) || product.exclusions.some(key => typeof key !== 'string' || !key))) {
    throw new Error('starter_subscription_configuration_invalid');
  }
}
