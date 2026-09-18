import type {
  ActivateCatalogProductRequest,
  ArchiveCatalogSkuRequest,
  CreateCatalogDraftRequest,
  SetCatalogPriceRequest,
  UpdateCatalogDraftRequest,
} from "../../../src/domains/commerce/adminCatalogContracts.js";
import type {
  ArchiveCatalogProductRequest,
  CloneCatalogDraftRequest,
  DeactivateCatalogProductRequest,
  RestoreCatalogProductRequest,
} from "../../../src/domains/commerce/adminCatalogLifecycleContracts.js";
import { DomainRpcError } from "../../_lib/admin-domain/rpcErrors.js";

/**
 * @agent-domain-reference
 * REFERENCE IMPLEMENTATION — the canonical agent-operable domain data port.
 *
 * Server-side data access for the admin/agent catalog write path. Each method is a
 * single call to a Wave 4b SECURITY DEFINER RPC — the RPC is the security boundary
 * (explicit actor, re-derived actor_kind, audit, idempotency, dry-run). The port
 * passes the resolved admin actorId through; it never re-implements the rules.
 */

/** Shape returned by every write RPC. */
export interface CatalogWriteResult {
  idempotent: boolean;
  dryRun: boolean;
  slug?: string;
  sku?: string;
  productId?: string;
}

export interface AdminCatalogDataPort {
  upsertDraft(actorId: string, input: CreateCatalogDraftRequest): Promise<CatalogWriteResult>;
  /**
   * Partial structural edit of a DRAFT product. The upsert RPC is full-payload, so
   * this reads the current product + its SKU, merges the supplied fields onto them,
   * and replays the merged payload through `admin_upsert_catalog_draft` (the same
   * security boundary). Throws a NOT_FOUND ({@link CatalogRpcError} P0002) when the
   * product/SKU does not exist.
   */
  updateDraft(actorId: string, input: UpdateCatalogDraftRequest): Promise<CatalogWriteResult>;
  setPrice(actorId: string, input: SetCatalogPriceRequest): Promise<CatalogWriteResult>;
  archiveSku(actorId: string, input: ArchiveCatalogSkuRequest): Promise<CatalogWriteResult>;
  activateProduct(
    actorId: string,
    input: ActivateCatalogProductRequest,
  ): Promise<CatalogWriteResult>;
  /** Archive a product + all its SKUs (status -> archived). Throws P0002 when missing. */
  archiveProduct(
    actorId: string,
    input: ArchiveCatalogProductRequest,
  ): Promise<CatalogWriteResult>;
  /**
   * Restore an archived product (+skus) -> draft. Throws P0002 when missing and
   * P0001 (`restore_requires_archived`) when the product is not archived.
   */
  restoreProduct(
    actorId: string,
    input: RestoreCatalogProductRequest,
  ): Promise<CatalogWriteResult>;
  /**
   * Unpublish a product (active -> draft). HUMAN-ONLY: the RPC RAISEs 42501
   * (`publish_requires_human`) for machine actors. Throws P0002 when missing and
   * P0001 (`deactivate_requires_active`) when the product is not active.
   */
  deactivateProduct(
    actorId: string,
    input: DeactivateCatalogProductRequest,
  ): Promise<CatalogWriteResult>;
  /**
   * Clone an existing product (any status) into a NEW draft (new slug + new sku).
   * BFF-orchestrated: reads the source via the read data port and replays a fresh
   * draft through `admin_upsert_catalog_draft` (no new RPC). Throws a NOT_FOUND
   * ({@link CatalogRpcError} P0002 `catalog_product_not_found`) when the source slug
   * does not exist.
   */
  cloneDraft(actorId: string, input: CloneCatalogDraftRequest): Promise<CatalogWriteResult>;
}

/**
 * Error carrying the Postgres SQLSTATE + message a write RPC RAISEd, so the handler
 * can map it to the BFF envelope (42501 -> FORBIDDEN, P0001 -> CONFLICT/rule, etc.).
 * A thin alias of the generic kit `DomainRpcError`, so `mapRpcError` handles it
 * uniformly and existing call sites (`new CatalogRpcError(code, message)`) are
 * unchanged.
 */
export class CatalogRpcError extends DomainRpcError {
  constructor(sqlstate: string | undefined, pgMessage: string) {
    super(sqlstate, pgMessage);
    this.name = "CatalogRpcError";
  }
}
