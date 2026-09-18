import type {
  CreateBundleDraftRequest,
  SetBundleCompositionRequest,
  SetBundleTargetPriceRequest,
  UpdateBundleDraftRequest,
} from "../../../src/domains/bundle/adminBundleContracts.js";
import type {
  ActivateBundleRequest,
  ArchiveBundleRequest,
  CloneBundleDraftRequest,
  DeactivateBundleRequest,
  RestoreBundleRequest,
} from "../../../src/domains/bundle/adminBundleLifecycleContracts.js";
import { DomainRpcError } from "../../_lib/admin-domain/rpcErrors.js";

/**
 * The semantic write port for the admin/agent bundle surface.
 *
 * This file names the CAPABILITY, never the storage. Both shipped adapters
 * (`server/adapters/supabase/bundleAdminWriteStore.ts`,
 * `server/adapters/postgres/bundleAdminWriteStore.ts`) implement exactly this
 * interface and are proved against ONE shared scenario table, so a caller cannot
 * tell them apart and neither can a rule. No data-client type, table name or
 * routine name appears here; the domain layer opens no database handle of its own.
 *
 * Each method is one atomic operation on the security boundary: the boundary takes
 * the actor explicitly, re-derives the actor kind rather than trusting the caller,
 * writes its audit row in the same transaction, short-circuits a replayed
 * idempotency key, and rolls a dry run back after validating it.
 */

/** Shape every bundle write returns. */
export interface BundleWriteResult {
  idempotent: boolean;
  dryRun: boolean;
  code?: string;
  bundleId?: string;
  componentCount?: number;
}

/** The opaque rules envelope a bundle carries, as the boundary hands it back. */
export interface BundleCompositionConstraintEnvelope {
  kind: string;
  version: number;
  data: Record<string, unknown>;
}

export interface AdminBundleWritePort {
  /**
   * Read the bundle's stored composition constraint. This is a WRITE-path read: the
   * whole-set replace must be validated against the envelope the bundle already
   * carries before anything is written, and the adopter's `CompositionRulesPort` is
   * the only thing that can decide it. Returns `null` for an unconstrained bundle.
   * Raises P0002 when the bundle does not exist.
   */
  loadCompositionConstraint(
    code: string,
  ): Promise<BundleCompositionConstraintEnvelope | null>;
  /** Create or edit a DRAFT bundle from a full structural payload. */
  upsertDraft(actorId: string, input: CreateBundleDraftRequest): Promise<BundleWriteResult>;
  /**
   * Partial structural edit of a DRAFT bundle. The upsert is full-payload, so this
   * reads the current bundle, overlays the supplied fields and replays the merged
   * payload through the same boundary. Raises NOT_FOUND (P0002) when the bundle
   * does not exist.
   */
  updateDraft(actorId: string, input: UpdateBundleDraftRequest): Promise<BundleWriteResult>;
  /**
   * Replace the bill of materials as a WHOLE SET, atomically. Raises P0002 when the
   * bundle or a named unit is missing, and P0001 when a unit is not sellable on its
   * own or is priced in another currency.
   */
  setComposition(actorId: string, input: SetBundleCompositionRequest): Promise<BundleWriteResult>;
  /**
   * Append a new active target price and close the previous one. Never mutates an
   * existing row. Raises P0001 when the target sits above the sum of the parts or
   * below the floor every component must clear.
   */
  setTargetPrice(actorId: string, input: SetBundleTargetPriceRequest): Promise<BundleWriteResult>;
  /** Remove a bundle from sale (status flip, never a hard delete). P0002 when missing. */
  archive(actorId: string, input: ArchiveBundleRequest): Promise<BundleWriteResult>;
  /**
   * Restore an archived bundle to draft. Raises P0002 when missing and P0001
   * (`restore_requires_archived`) when the bundle is not archived.
   */
  restore(actorId: string, input: RestoreBundleRequest): Promise<BundleWriteResult>;
  /**
   * Clone any bundle into a NEW draft under a new code, including its composition.
   * Raises P0002 (`clone_source_not_found`) when the source is missing and P0001
   * when the target code is already taken.
   */
  cloneDraft(actorId: string, input: CloneBundleDraftRequest): Promise<BundleWriteResult>;
  /**
   * Publish (draft -> active). HUMAN-ONLY: the boundary RAISEs 42501
   * (`publish_requires_human`) for machine actors. Raises P0001 when the bundle has
   * no composition or no active target price.
   */
  activate(actorId: string, input: ActivateBundleRequest): Promise<BundleWriteResult>;
  /**
   * Unpublish (active -> draft). HUMAN-ONLY, same 42501. Raises P0001
   * (`deactivate_requires_active`) when the bundle is not live.
   */
  deactivate(actorId: string, input: DeactivateBundleRequest): Promise<BundleWriteResult>;
}

/**
 * Error carrying the SQLSTATE + message the write boundary raised, so the handler
 * maps it onto the BFF envelope (42501 -> FORBIDDEN, P0001 -> CONFLICT/rule,
 * P0002 -> NOT_FOUND). A thin alias of the generic kit `DomainRpcError` so
 * `mapRpcError` handles it uniformly.
 */
export class BundleRpcError extends DomainRpcError {
  constructor(sqlstate: string | undefined, message: string) {
    super(sqlstate, message);
    this.name = "BundleRpcError";
  }
}
