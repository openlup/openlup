import type { PgQueryExecutor } from "../data/index.js";
import type { CatalogDraftPriceOperationV2 } from "./contracts/draftV2.js";
import type { CatalogProductTypeRegistry } from "./contracts/productTypes.js";
import type { CatalogAttributeReferencePort } from "./attributeReferencePort.js";
import type { CatalogPublishedProduct, CatalogPublishedSku, CatalogRetainedSourceBinding } from "./contracts/publication.js";
import type { CatalogPublicationRules } from "./publicationValidation.js";
import type { VerifiedCatalogPublisher } from "./publicationPorts.js";

declare const verifiedReadScope: unique symbol;
/** @experimental */
export interface VerifiedCatalogReadScope { readonly [verifiedReadScope]: true }
/** @experimental */
export interface CatalogPublicationTransactions { run<T>(work: (db: PgQueryExecutor) => Promise<T>): Promise<T> }
/** The price owner supplies the opaque, same-product prelocked batch; no price policy is implemented here.
 * @experimental
 */
export interface CatalogPublicationPriceBoundary {
  prelock(db: PgQueryExecutor, actor: VerifiedCatalogPublisher, productId: string,
    commands: readonly CatalogDraftPriceOperationV2[]): Promise<unknown>;
  applyInTransaction(db: PgQueryExecutor, actor: VerifiedCatalogPublisher, parentProductId: string, prelockedBatch: unknown): Promise<void>;
}
/** @experimental */
export interface CatalogPublicationDependencies<Context> {
  transactions: CatalogPublicationTransactions;
  registry: CatalogProductTypeRegistry;
  rules: CatalogPublicationRules;
  /** Adapt the host's human authorization outcome; machine identity must be explicit. */
  authorizeHuman(context: Context): Promise<{ ok: true; userId: string; role: string; isMachineActor: boolean } | { ok: false }>;
  attributeReferences?: CatalogAttributeReferencePort;
  prices?: CatalogPublicationPriceBoundary;
  /** Runs in the publication transaction; no external I/O or commerce locks. Missing required evidence refuses. */
  readiness(db: PgQueryExecutor, state: { product: CatalogPublishedProduct; skus: readonly CatalogPublishedSku[] }, requirePrice: boolean): Promise<{ ready: boolean; reasons: readonly string[] }>;
  globalReadiness?(db: PgQueryExecutor): Promise<{ ready: boolean; reasons: readonly string[] }>;
  /** External proof is prepared before locks; transaction-local admission verifies this immutable claim again. */
  verifyMedia(db: PgQueryExecutor, claim: { skuCode: string; mediaRef: string; assetRefs: readonly string[]; revisionDigest: string }): Promise<boolean>;
  /** Host owns accepted-source persistence and ownership/order/fulfilment authorization. Legacy absence is null, never current-state inference. */
  acceptedSource?(db: PgQueryExecutor, context: Context, binding: CatalogRetainedSourceBinding): Promise<CatalogRetainedSourceBinding | null | "unauthorized">;
}
