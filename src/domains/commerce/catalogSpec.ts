import type { z } from "zod";

import type {
  AgentDomainMutationSpec,
  AgentDomainQuerySpec,
  AgentDomainSpec,
} from "../../lib/agent-domain/domainSpec.js";
import { catalogProductSlugSchema } from "../catalog/contracts.js";
import { CATALOG_RULE_CODES, type CatalogRuleCode } from "./catalogRuleCodes.js";
import { evaluateCatalogWriteRules } from "./catalogRules.js";
import {
  activateCatalogProductRequestSchema,
  archiveCatalogSkuRequestSchema,
  createCatalogDraftRequestSchema,
  setCatalogPriceRequestSchema,
  updateCatalogDraftRequestSchema,
} from "./adminCatalogContracts.js";
import {
  archiveCatalogProductRequestSchema,
  cloneCatalogDraftRequestSchema,
  deactivateCatalogProductRequestSchema,
  restoreCatalogProductRequestSchema,
} from "./adminCatalogLifecycleContracts.js";
import {
  catalogHistoryRequestSchema,
  getCatalogProductRequestSchema,
  listCatalogProductsRequestSchema,
} from "./adminCatalogReadContracts.js";
import {
  getCatalogDocumentAuthorityRequestSchema,
  submitCatalogDocumentProposalRequestSchema,
} from "./adminCatalogDocumentContracts.js";

/**
 * @agent-domain-reference
 * REFERENCE IMPLEMENTATION — the canonical `AgentDomainSpec`. This is the single
 * typed seam the write-handler factory consumes today and the MCP tool generator
 * will consume in Wave 5; an incomplete domain is a COMPILE error here. Copy this
 * file's shape (token-substituting `catalog`→`X`) to stand up a new domain.
 *
 * The MCP generator drops every mutation carrying a `lifecycleMarker` (here:
 * `activate`), so agents are draft-only; a human React head keeps it.
 */

type CatalogId = z.infer<typeof catalogProductSlugSchema>;

export const CATALOG_MUTATION_FLAG = "COMMERCE_CATALOG_MUTATIONS_ENABLED" as const;
export const CATALOG_ACTIVATION_FLAG = "COMMERCE_CATALOG_ACTIVATION_ENABLED" as const;

/** Operation keys; also the basis for the MCP tool names `catalog__*` (Wave 5). */
export type CatalogMutationKey =
  | "create"
  | "update"
  | "setPrice"
  | "archive"
  | "activate"
  | "archiveProduct"
  | "restore"
  | "cloneDraft"
  | "deactivate"
  | "proposeDocument";

/** Read operation keys; basis for the MCP read tool names `catalog__*`. */
export type CatalogQueryKey = "list" | "get" | "history" | "document";

const mutations: Record<CatalogMutationKey, AgentDomainMutationSpec> = {
  create: {
    key: "create_draft",
    requestSchema: createCatalogDraftRequestSchema,
    gate: "mutation",
    allowedActorKinds: ["human", "machine"],
    lifecycleMarkers: [],
  },
  update: {
    key: "update_draft",
    requestSchema: updateCatalogDraftRequestSchema,
    gate: "mutation",
    // Draft-only partial edit (structural fields). Same actor latitude as create:
    // agents may edit drafts; only activation is human-gated.
    allowedActorKinds: ["human", "machine"],
    lifecycleMarkers: [],
  },
  setPrice: {
    key: "set_price",
    requestSchema: setCatalogPriceRequestSchema,
    gate: "mutation",
    allowedActorKinds: ["human", "machine"],
    lifecycleMarkers: [],
  },
  archive: {
    key: "archive",
    requestSchema: archiveCatalogSkuRequestSchema,
    gate: "mutation",
    allowedActorKinds: ["human", "machine"],
    lifecycleMarkers: [],
  },
  activate: {
    key: "activate",
    requestSchema: activateCatalogProductRequestSchema,
    gate: "activation",
    // Human-only, enforced at TWO independent machine-checked layers (§1.3 Invariant 3):
    // the handler factory rejects a non-human actor (403, reason `actor_kind_not_allowed`)
    // from this `allowedActorKinds`, AND the activate RPC RAISEs 42501
    // (`publish_requires_human`). Both re-derive the actor kind from
    // `admin_users.is_machine_actor`. The MCP generator also drops this tool.
    allowedActorKinds: ["human"],
    lifecycleMarkers: ["LIFECYCLE_ACTIVATE"],
  },
  archiveProduct: {
    key: "archive_product",
    requestSchema: archiveCatalogProductRequestSchema,
    gate: "mutation",
    // Whole-product archive (status flip, never hard-delete). Agent-allowed: it
    // removes a product from sale but is reversible via restore.
    allowedActorKinds: ["human", "machine"],
    lifecycleMarkers: [],
  },
  restore: {
    key: "restore",
    requestSchema: restoreCatalogProductRequestSchema,
    gate: "mutation",
    // Restore archived -> draft. Agent-allowed: the target is draft, so nothing
    // becomes sellable without a separate human activation.
    allowedActorKinds: ["human", "machine"],
    lifecycleMarkers: [],
  },
  cloneDraft: {
    key: "clone_draft",
    requestSchema: cloneCatalogDraftRequestSchema,
    gate: "mutation",
    // Clone any product into a NEW draft (new slug + new sku). Agent-allowed:
    // BFF-orchestrated through the existing draft upsert; born draft.
    allowedActorKinds: ["human", "machine"],
    lifecycleMarkers: [],
  },
  deactivate: {
    key: "deactivate",
    requestSchema: deactivateCatalogProductRequestSchema,
    gate: "activation",
    // Unpublish (active -> draft) is a publish-state transition, so it is HUMAN-ONLY
    // at TWO independent machine-checked layers (same as activate): the handler
    // factory rejects a non-human actor (403, `actor_kind_not_allowed`) and the
    // deactivate RPC RAISEs 42501 (`publish_requires_human`). The `LIFECYCLE_DEACTIVATE`
    // marker also makes the MCP generator DROP this tool — there is no
    // `catalog__deactivate`. Reachable only via its BFF route for the React head.
    allowedActorKinds: ["human"],
    lifecycleMarkers: ["LIFECYCLE_DEACTIVATE"],
  },
  proposeDocument: {
    key: "propose_document",
    requestSchema: submitCatalogDocumentProposalRequestSchema,
    gate: "mutation",
    // Submitting a change proposal writes an immutable evidence row whose
    // `publication_ready` is false by CHECK constraint: it makes nothing
    // sellable and moves no document pointer, so an agent may raise one. The
    // human-only acts - publish, decision, rollback - are deliberately NOT
    // exposed over the BFF at all; they are `GRANT ... authenticated` and read
    // `auth.uid()`, so a service-role route could only reach them by laundering
    // a machine actor through a human gate. No lifecycle marker, so the MCP
    // generator keeps this tool.
    allowedActorKinds: ["human", "machine"],
    lifecycleMarkers: [],
  },
};

const queries: Record<CatalogQueryKey, AgentDomainQuerySpec> = {
  list: {
    key: "list",
    requestSchema: listCatalogProductsRequestSchema,
    gate: "read",
    allowedActorKinds: ["human", "machine"],
  },
  get: {
    key: "get",
    requestSchema: getCatalogProductRequestSchema,
    gate: "read",
    allowedActorKinds: ["human", "machine"],
  },
  history: {
    key: "history",
    requestSchema: catalogHistoryRequestSchema,
    gate: "read",
    allowedActorKinds: ["human", "machine"],
  },
  document: {
    key: "read_document",
    requestSchema: getCatalogDocumentAuthorityRequestSchema,
    gate: "read",
    allowedActorKinds: ["human", "machine"],
  },
};

export const catalogSpec: AgentDomainSpec<CatalogId, CatalogRuleCode, Record<string, unknown>> = {
  domainKey: "catalog",
  mutationFlag: CATALOG_MUTATION_FLAG,
  activationFlag: CATALOG_ACTIVATION_FLAG,
  idSchema: catalogProductSlugSchema,
  ruleCodes: CATALOG_RULE_CODES,
  rules: evaluateCatalogWriteRules,
  auditEntityType: "catalog_product",
  mutations,
  queries,
};
