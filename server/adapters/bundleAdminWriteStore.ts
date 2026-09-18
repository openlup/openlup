import type {
  CreateBundleDraftRequest,
  SetBundleCompositionRequest,
  SetBundleTargetPriceRequest,
  UpdateBundleDraftRequest,
} from "../../src/domains/bundle/adminBundleContracts.js";
import type {
  ActivateBundleRequest,
  ArchiveBundleRequest,
  CloneBundleDraftRequest,
  DeactivateBundleRequest,
  RestoreBundleRequest,
} from "../../src/domains/bundle/adminBundleLifecycleContracts.js";
import {
  BundleRpcError,
  type AdminBundleWritePort,
  type BundleCompositionConstraintEnvelope,
  type BundleWriteResult,
} from "../domains/bundle/adminBundleWritePort.js";

/**
 * The marshalling both bundle write adapters share.
 *
 * The two shipped adapters differ in exactly one thing: which client executes a
 * named routine call. Everything else — argument names, result normalization,
 * error translation — is identical, so it lives here once rather than being
 * copied and left to drift. Each adapter supplies its own client and owns its own
 * lifecycle; neither owns a rule.
 */

/** What a client returns, in the one shape both chains already speak. */
type ClientResult = { data: unknown; error: { code?: string; message?: string } | null };

/**
 * The two capabilities an adapter must supply: execute a named routine, and read
 * one column by equality. The second exists only for the constraint envelope the
 * composition rules must be validated against before anything is written; every
 * decision still belongs to a routine or to the rules port.
 */
export interface BundleWriteRoutineClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<ClientResult>;
  from(table: string): {
    select(columns: string): { eq(column: string, value: unknown): PromiseLike<ClientResult> };
  };
}

/** The routine names the write boundary publishes, in both chains. */
export const BUNDLE_WRITE_ROUTINES = {
  upsertDraft: "admin_upsert_bundle_draft",
  setComposition: "admin_set_bundle_composition",
  setTargetPrice: "admin_set_bundle_target_price",
  archive: "admin_archive_bundle",
  restore: "admin_restore_bundle",
  activate: "admin_activate_bundle",
  deactivate: "admin_deactivate_bundle",
} as const;

/** The relation the constraint envelope is read from, identical in both chains. */
export const BUNDLE_RELATION = "catalog_bundles";

/**
 * Clone has NO routine of its own. It is the draft upsert with a source named:
 * one transaction copies the source's structural fields and its whole bill of
 * materials into a new draft, and records the same `bundle_draft_upsert` audit
 * action the plain upsert records. A second routine would have been a second
 * place for the same rules to be written down.
 */

function row(data: unknown): Record<string, unknown> {
  const value = Array.isArray(data) ? data[0] : data;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function bundleWriteResult(data: unknown): BundleWriteResult {
  const value = row(data);
  return {
    idempotent: value.idempotent === true,
    dryRun: value.dryRun === true,
    ...(text(value.code) === undefined ? {} : { code: text(value.code) as string }),
    ...(text(value.bundleId) === undefined ? {} : { bundleId: text(value.bundleId) as string }),
    ...(typeof value.componentCount === "number" ? { componentCount: value.componentCount } : {}),
  };
}

function constraintEnvelope(data: unknown): BundleCompositionConstraintEnvelope | null {
  const stored = row(data).composition_constraint;
  const value = stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
  const kind = text(value.kind);
  if (!kind) return null;
  return {
    kind,
    version: typeof value.version === "number" ? value.version : 0,
    data: value.data && typeof value.data === "object" ? (value.data as Record<string, unknown>) : {},
  };
}

type DraftFields = {
  title?: string;
  fulfillmentMode?: string;
  compositionConstraint?: unknown;
  metadata?: unknown;
};

function draftArguments(
  actorId: string,
  code: string,
  fields: DraftFields,
  envelope: { mode: string; idempotencyKey?: string },
  cloneFromCode: string | null = null,
): Record<string, unknown> {
  return {
    p_actor_id: actorId,
    p_code: code,
    p_title: fields.title ?? null,
    p_fulfillment_mode: fields.fulfillmentMode ?? null,
    p_composition_constraint: fields.compositionConstraint ?? null,
    p_metadata: fields.metadata ?? null,
    p_clone_from_code: cloneFromCode,
    p_mode: envelope.mode,
    p_idempotency_key: envelope.idempotencyKey ?? null,
  };
}

/**
 * Build the bundle write port over one routine client. Errors are translated to
 * `BundleRpcError` so the handler's shared mapper turns 42501 into FORBIDDEN,
 * P0001 into a rule conflict and P0002 into NOT_FOUND, identically on both chains.
 */
export function createBundleAdminWriteStore(client: BundleWriteRoutineClient): AdminBundleWritePort {
  async function call(name: string, args: Record<string, unknown>): Promise<BundleWriteResult> {
    const { data, error } = await client.rpc(name, args);
    if (error) throw new BundleRpcError(error.code, error.message ?? `${name} failed`);
    return bundleWriteResult(data);
  }

  function lifecycle(
    name: string,
  ): (
    actorId: string,
    input: ArchiveBundleRequest | RestoreBundleRequest | ActivateBundleRequest | DeactivateBundleRequest,
  ) => Promise<BundleWriteResult> {
    return (actorId, input) =>
      call(name, {
        p_actor_id: actorId,
        p_code: input.code,
        p_mode: input.mode,
        p_idempotency_key: input.idempotencyKey ?? null,
      });
  }

  return {
    async loadCompositionConstraint(code) {
      const { data, error } = await client
        .from(BUNDLE_RELATION)
        .select("code, composition_constraint")
        .eq("code", code);
      if (error) throw new BundleRpcError(error.code, error.message ?? "bundle constraint read failed");
      const rows = Array.isArray(data) ? data : data === null || data === undefined ? [] : [data];
      if (rows.length === 0) throw new BundleRpcError("P0002", "bundle_not_found");
      return constraintEnvelope(rows[0]);
    },
    upsertDraft(actorId, input: CreateBundleDraftRequest) {
      return call(
        BUNDLE_WRITE_ROUTINES.upsertDraft,
        draftArguments(actorId, input.bundle.code, input.bundle, input),
      );
    },
    updateDraft(actorId, input: UpdateBundleDraftRequest) {
      return call(
        BUNDLE_WRITE_ROUTINES.upsertDraft,
        draftArguments(actorId, input.code, input.updates, input),
      );
    },
    setComposition(actorId, input: SetBundleCompositionRequest) {
      return call(BUNDLE_WRITE_ROUTINES.setComposition, {
        p_actor_id: actorId,
        p_code: input.code,
        p_components: input.components.map((component) => ({
          sku: component.sku,
          quantity: component.quantity,
          is_addon: component.isAddon,
          sort_order: component.sortOrder,
        })),
        p_mode: input.mode,
        p_idempotency_key: input.idempotencyKey ?? null,
      });
    },
    setTargetPrice(actorId, input: SetBundleTargetPriceRequest) {
      return call(BUNDLE_WRITE_ROUTINES.setTargetPrice, {
        p_actor_id: actorId,
        p_code: input.code,
        p_price_mode: input.price.mode,
        p_target_price_minor: input.price.targetPriceMinor,
        p_currency: input.price.currency,
        p_amount_kind: input.price.amountKind,
        p_mode: input.mode,
        p_idempotency_key: input.idempotencyKey ?? null,
      });
    },
    cloneDraft(actorId, input: CloneBundleDraftRequest) {
      return call(
        BUNDLE_WRITE_ROUTINES.upsertDraft,
        draftArguments(
          actorId,
          input.code,
          input.title === undefined ? {} : { title: input.title },
          input,
          input.sourceCode,
        ),
      );
    },
    archive: lifecycle(BUNDLE_WRITE_ROUTINES.archive),
    restore: lifecycle(BUNDLE_WRITE_ROUTINES.restore),
    activate: lifecycle(BUNDLE_WRITE_ROUTINES.activate),
    deactivate: lifecycle(BUNDLE_WRITE_ROUTINES.deactivate),
  };
}
