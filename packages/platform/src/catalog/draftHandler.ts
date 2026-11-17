import { catalogLifecycleStoredCommandSchema, catalogLifecycleStoredRecordSchema, catalogLifecycleStoredApplyResultSchema, catalogLifecycleValidationPayload } from "./lifecycleV2.js";
import { createHash } from "node:crypto";
import {
  canonicalCatalogDraftJson,
  catalogDraftApplyResultSchema, catalogDraftCommandSchema, catalogDraftRecordSchema,
  catalogDraftGetQuerySchema, catalogDraftListQuerySchema, catalogDraftPageSchema,
  catalogDraftRefusalSchema,
  type CatalogDraftApplyResult, type CatalogDraftRecord, type CatalogDraftPage, type CatalogDraftRefusal,
} from "./draftSchemas.js";
import { catalogDraftStoredApplyResultSchema, catalogDraftStoredCommandSchema, catalogDraftStoredRecordSchema } from "./draftV2Schemas.js";
import type { CatalogDraftStoredRecord } from "./contracts/draftV2.js";
import type { CatalogDraftPublicationStoredCommand, CatalogDraftPublicationStoredRecord } from "./contracts/draftV3.js";
import type { CatalogLifecycleStoredRecord, CatalogLifecycleStoredCommand } from "./contracts/lifecycleV2.js";
import { catalogDraftPublicationStoredApplyResultSchema, catalogDraftPublicationStoredCommandSchema, catalogDraftPublicationStoredRecordSchema, catalogDraftV3ValidationPayload } from "./draftV3Schemas.js";
import type { z } from "./validation.js";
import type { CatalogAttributeReferencePort } from "./attributeReferencePort.js";
import { validateCatalogDraftV2 } from "./draftV2Validation.js";
import {
  CatalogDraftStoreError, type CatalogDraftOperator, type CatalogDraftStorePort,
} from "./draftPorts.js";
import type { CatalogDraftIssue, CatalogProductTypeRegistry } from "./productTypeSchemas.js";
import { validateCatalogDraft, type CatalogDraftReadiness } from "./draftValidation.js";

export interface CatalogDraftHandlerDeps<Context, Record extends CatalogLifecycleStoredRecord = CatalogDraftRecord> {
  store: CatalogDraftStorePort<Record>;
  registry: CatalogProductTypeRegistry;
  attributeReferences?: CatalogAttributeReferencePort;
  authorizeOperator: (context: Context) => Promise<CatalogDraftOperator | null>;
}
export type CatalogDraftCommandResult = CatalogDraftApplyResult & {
  issues?: readonly CatalogDraftIssue[]; readiness?: CatalogDraftReadiness;
};
const unavailable = (): CatalogDraftRefusal => ({ outcome: "dependency_unavailable", reason: "draft_dependency_unavailable" });
const invalid = (): CatalogDraftRefusal => ({ outcome: "validation_issue", reason: "draft_input_invalid" });
function failure(error: unknown): CatalogDraftRefusal {
  if (error instanceof CatalogDraftStoreError) {
    const parsed = catalogDraftRefusalSchema.safeParse(error.refusal);
    if (parsed.success) return parsed.data;
  }
  return unavailable();
}

/** Dark use case: mounting requires a verified operator authorizer at composition. */
function draftHandler<Context, Record extends CatalogLifecycleStoredRecord>(deps: CatalogDraftHandlerDeps<Context, Record>, schemas: {
  command: z.ZodType<CatalogLifecycleStoredCommand>; record: z.ZodType<Record>;
  result: z.ZodType<{ outcome: "committed" | "replayed"; record: Record } | CatalogDraftRefusal>;
}) {
  const { command: catalogDraftCommandSchema, record: catalogDraftRecordSchema, result: catalogDraftApplyResultSchema } = schemas;
  async function actor(context: Context): Promise<CatalogDraftOperator | CatalogDraftRefusal> {
    try {
      const operator = await deps.authorizeOperator(context);
      if (!operator || !/^[^\s].{0,239}$/u.test(operator.actorId) || operator.actorId.trim() !== operator.actorId) {
        return { outcome: "unauthorized", reason: "draft_operator_required" };
      }
      return operator;
    } catch { return unavailable(); }
  }
  return {
    async execute(input: unknown, context: Context): Promise<({ outcome: "committed" | "replayed"; record: Record } | CatalogDraftRefusal) & {
      issues?: readonly CatalogDraftIssue[]; readiness?: CatalogDraftReadiness;
    }> {
      const operator = await actor(context);
      if ("outcome" in operator) return operator;
      let canonicalCommand: string;
      try { canonicalCommand = canonicalCatalogDraftJson(input); } catch { return invalid(); }
      const parsed = catalogDraftCommandSchema.safeParse(JSON.parse(canonicalCommand));
      if (!parsed.success) return invalid();
      const command = parsed.data;
      const fingerprint = createHash("sha256").update(canonicalCommand).digest("hex");
      try {
        // Read receipts first: changed registry, moved head or abandonment cannot erase a committed command.
        const original = await deps.store.get({ draftId: command.draftId, commandKey: command.commandKey }, operator.actorId);
        if (original !== null) {
          const record = catalogDraftRecordSchema.parse(original);
          if (record.draftId !== command.draftId || record.commandKey !== command.commandKey) return unavailable();
          if (record.actorId !== operator.actorId) return { outcome: "unauthorized", reason: "draft_command_actor_mismatch" };
          if (record.fingerprint !== fingerprint) return { outcome: "conflict", reason: "draft_command_key_reused" };
          return { outcome: "replayed", record };
        }
        let readiness: CatalogDraftReadiness | undefined;
        if (command.payload) {
          const validation = command.payload.schemaVersion !== 1
            ? await validateCatalogDraftV2(command.payload.schemaVersion === 2 ? command.payload : catalogLifecycleValidationPayload(command.payload), deps.registry, deps.attributeReferences)
            : validateCatalogDraft(command.payload, deps.registry);
          if (!validation.valid) return { outcome: "validation_issue", reason: "draft_payload_invalid", issues: validation.issues };
          readiness = validation.readiness;
        }
        const result = catalogDraftApplyResultSchema.parse(await deps.store.apply({ canonicalCommand, fingerprint, actorId: operator.actorId }));
        if (result.outcome === "committed" || result.outcome === "replayed") {
          if (result.record.draftId !== command.draftId || result.record.commandKey !== command.commandKey
            || result.record.fingerprint !== fingerprint || result.record.actorId !== operator.actorId) return unavailable();
          return { ...result, ...(readiness ? { readiness } : {}) };
        }
        return result;
      } catch (error) { return failure(error); }
    },
    async get(input: unknown, context: Context): Promise<{ outcome: "found"; record: Record | null } | CatalogDraftRefusal> {
      const operator = await actor(context);
      if ("outcome" in operator) return operator;
      const parsed = catalogDraftGetQuerySchema.safeParse(input);
      if (!parsed.success) return invalid();
      try {
        const value = await deps.store.get(parsed.data, operator.actorId);
        const record = value === null ? null : catalogDraftRecordSchema.parse(value);
        if (record && (record.draftId !== parsed.data.draftId
          || (parsed.data.revision !== undefined && record.revision !== parsed.data.revision)
          || (parsed.data.commandKey !== undefined && record.commandKey !== parsed.data.commandKey))) return unavailable();
        return { outcome: "found", record };
      } catch (error) { return failure(error); }
    },
    async list(input: unknown, context: Context): Promise<{ outcome: "listed"; page: CatalogDraftPage } | CatalogDraftRefusal> {
      const operator = await actor(context);
      if ("outcome" in operator) return operator;
      const parsed = catalogDraftListQuerySchema.safeParse(input);
      if (!parsed.success) return invalid();
      try {
        const page = catalogDraftPageSchema.parse(await deps.store.list(parsed.data, operator.actorId));
        if (page.items.length > parsed.data.limit || (parsed.data.afterDraftId
          && page.items.some(({ draftId }) => draftId <= parsed.data.afterDraftId!))) return unavailable();
        return { outcome: "listed", page };
      } catch (error) { return failure(error); }
    },
  };
}

/** Existing v1 composition and wire admission stay unchanged. */
export function createCatalogDraftHandler<Context>(deps: CatalogDraftHandlerDeps<Context>) {
  return draftHandler(deps, { command: catalogDraftCommandSchema, record: catalogDraftRecordSchema, result: catalogDraftApplyResultSchema });
}
/** Explicit opt-in v1/v2 reader and versioned command admission; no binding is installed.
 * @experimental
 */
export function createCatalogDraftHandlerV2<Context>(deps: CatalogDraftHandlerDeps<Context, CatalogDraftStoredRecord>) {
  return draftHandler(deps, { command: catalogDraftStoredCommandSchema, record: catalogDraftStoredRecordSchema, result: catalogDraftStoredApplyResultSchema });
}

/** Opt-in publication inputs, with the same draft authorization and receipt-first replay.
 * @experimental
 */
export function createCatalogDraftHandlerV3<Context>(deps: CatalogDraftHandlerDeps<Context, CatalogDraftPublicationStoredRecord>) {
  return draftHandler(deps, { command: catalogDraftPublicationStoredCommandSchema, record: catalogDraftPublicationStoredRecordSchema, result: catalogDraftPublicationStoredApplyResultSchema });
}

/** Lifecycle authoring shares authorization, immutable receipts and scalar validation.
 * @experimental
 */
export function createCatalogDraftHandlerV4<Context>(deps: CatalogDraftHandlerDeps<Context, CatalogLifecycleStoredRecord>) {
  return draftHandler(deps, { command: catalogLifecycleStoredCommandSchema, record: catalogLifecycleStoredRecordSchema, result: catalogLifecycleStoredApplyResultSchema });
}
