import type { PackageEditMoney, PackageEditQuoteLine } from "./contracts/packageEdit.js";
export type { PackageEditMoney, PackageEditLine, PackageEditQuoteLine, PackageEditPricedLine, PackageEditRequest, PackageEditQuote, PackageEditBlockedReason, PackageEditPreview, PackageEditApplyResult } from "./contracts/packageEdit.js";
import type { CompositionConstraint, CompositionRulesPort } from "@openlup/core/bundle";
import type { SubscriptionQueryExecutor } from "./postgresRenewalStore.js";
import type { SubscriptionPortionModes } from "./contracts/exactEdit.js";

/** Trusted host ports; neither identity nor price evidence comes from a browser. */
export interface PackageEditSubscription {
  cadenceDays: number; templateVersion: number; compositionConstraint: Record<string, unknown> | null;
}
export interface PackageEditCurrentLine {
  lineId: string; variantId: string; quantity: number; sortOrder: number; isAddon: boolean;
  frozenLineSubtotalGross?: PackageEditMoney;
}
/** Adapters translate the persisted carrier. Native classic edits persist the constraint the
 * host quoted for the accepted plan; the host recognizes its own plan-length kind. */
export interface PackageEditConstraintMapper {
  toCore(stored: Record<string, unknown> | null): CompositionConstraint;
  fromCore(constraint: CompositionConstraint): Record<string, unknown> | null;
  nominalPlanDays(stored: Record<string, unknown> | null): number | null;
}
export interface PackageEditReadPort {
  readSubscription(subscriptionId: string): Promise<PackageEditSubscription>;
  readLines(subscriptionId: string): Promise<PackageEditCurrentLine[]>;
  readMinimumBaseUnits(): Promise<number>;
}
/** Compose the existing quote engine with Q1/Q2 authority, no promotion or settings ports,
 * zero automatic/code promotions, and use its server-authoritative method. */
export interface PackageEditQuotePorts {
  quoteCatalogReadPort: { listQuoteCatalogItems(): Promise<{ variantId: string; skuCode: string; sellability: { subscription: boolean } }[]> };
  quotePort: { createServerAuthoritativeQuote(request: {
    mode: "subscription"; cadenceDays: number; compositionConstraint: Record<string, unknown> | null; promoCodes: string[];
    lines: { sku: string; quantity: number; modeAtLine: "subscription"; isAddon: boolean }[];
  }): Promise<{ quote: { totalGross: PackageEditMoney; subtotalGross: PackageEditMoney; discountTotalGross: PackageEditMoney; lines: PackageEditQuoteLine[] } }> };
  compositionRulesPort: CompositionRulesPort;
  constraintMapper: PackageEditConstraintMapper;
}
export interface PackageEditLimits { maximumPlanDays: number; maximumBaseLines: number; maximumAddonLines: number; maximumQuantity: number }
export interface PackageEditorOptions extends PackageEditQuotePorts {
  /** Required only for the exact portion lever. */
  portionModes?: SubscriptionPortionModes;
  /** One connection through commit/rollback; authorization precedes this factory. */
  withTransaction<T>(work: (db: SubscriptionQueryExecutor) => Promise<T>): Promise<T>;
  limits: PackageEditLimits;
  now(): string;
}
export interface PackageEditActor { actorId: string; clientId: string }
