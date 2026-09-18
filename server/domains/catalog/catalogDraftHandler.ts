import { createHash } from "node:crypto";
import {
  canonicalCatalogDraftJson, catalogDraftApplyResultSchema, catalogDraftCommandSchema,
  catalogDraftGetQuerySchema, catalogDraftListQuerySchema, catalogDraftPageSchema,
  catalogDraftRecordSchema, catalogDraftRefusalSchema,
  type CatalogDraftApplyResult, type CatalogDraftPage, type CatalogDraftRecord, type CatalogDraftRefusal,
} from "../../../src/domains/catalog/catalogDraftContracts.js";
import {
  CatalogDraftStoreError, type CatalogDraftOperator, type CatalogDraftStorePort,
} from "../../../src/domains/catalog/catalogDraftPorts.js";
import type { CatalogDraftIssue, CatalogProductTypeRegistry } from "../../../src/domains/catalog/catalogProductTypeContracts.js";
import { validateCatalogDraft, type CatalogDraftReadiness } from "./catalogDraftValidation.js";

export interface CatalogDraftHandlerDeps<Context> {
  store: CatalogDraftStorePort;
  registry: CatalogProductTypeRegistry;
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
export function createCatalogDraftHandler<Context>(deps: CatalogDraftHandlerDeps<Context>) {
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
    async execute(input: unknown, context: Context): Promise<CatalogDraftCommandResult> {
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
          const validation = validateCatalogDraft(command.payload, deps.registry);
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
    async get(input: unknown, context: Context): Promise<{ outcome: "found"; record: CatalogDraftRecord | null } | CatalogDraftRefusal> {
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
