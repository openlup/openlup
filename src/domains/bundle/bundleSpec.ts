import type { z } from "zod";

import type {
  AgentDomainMutationSpec,
  AgentDomainQuerySpec,
  AgentDomainSpec,
} from "../../lib/agent-domain/domainSpec.js";
import {
  bundleHistoryRequestSchema,
  getBundleRequestSchema,
  listBundlesRequestSchema,
  previewBundlePriceRequestSchema,
} from "./adminBundleReadContracts.js";
import { BUNDLE_RULE_CODES, type BundleRuleCode } from "./bundleRuleCodes.js";
import { evaluateBundleWriteRules } from "./bundleRules.js";
import {
  bundleCodeSchema,
  createBundleDraftRequestSchema,
  setBundleCompositionRequestSchema,
  setBundleTargetPriceRequestSchema,
  updateBundleDraftRequestSchema,
} from "./adminBundleContracts.js";
import {
  activateBundleRequestSchema,
  archiveBundleRequestSchema,
  cloneBundleDraftRequestSchema,
  deactivateBundleRequestSchema,
  restoreBundleRequestSchema,
} from "./adminBundleLifecycleContracts.js";

/**
 * The bundle domain's `AgentDomainSpec` — the single typed seam the write-handler
 * factory and the MCP tool generator both consume. An incomplete domain is a
 * COMPILE error here. The catalog spec (`src/domains/commerce/catalogSpec.ts`) is
 * the reference this follows.
 *
 * The MCP generator drops every mutation carrying a `lifecycleMarker`, so the two
 * publish-state transitions (`activate`, `deactivate`) are structurally absent
 * from the agent surface; a human head keeps them.
 */

type BundleId = z.infer<typeof bundleCodeSchema>;

export const BUNDLE_MUTATION_FLAG = "COMMERCE_BUNDLE_MUTATIONS_ENABLED" as const;
export const BUNDLE_ACTIVATION_FLAG = "COMMERCE_BUNDLE_ACTIVATION_ENABLED" as const;
export const BUNDLE_READ_FLAG = "COMMERCE_BUNDLE_READ_ENABLED" as const;

/** Operation keys; also the basis for the MCP tool names `bundle__*`. */
export type BundleMutationKey =
  | "create"
  | "update"
  | "setComposition"
  | "setTargetPrice"
  | "archive"
  | "restore"
  | "cloneDraft"
  | "activate"
  | "deactivate";

const mutations: Record<BundleMutationKey, AgentDomainMutationSpec> = {
  create: {
    key: "create_draft",
    requestSchema: createBundleDraftRequestSchema,
    gate: "mutation",
    allowedActorKinds: ["human", "machine"],
    lifecycleMarkers: [],
  },
  update: {
    key: "update_draft",
    requestSchema: updateBundleDraftRequestSchema,
    gate: "mutation",
    // Draft-only partial edit of the bundle's own structural fields. Same actor
    // latitude as create: agents edit drafts; only publishing is human-gated.
    allowedActorKinds: ["human", "machine"],
    lifecycleMarkers: [],
  },
  setComposition: {
    key: "set_composition",
    requestSchema: setBundleCompositionRequestSchema,
    gate: "mutation",
    // Whole-set atomic replace of the bill of materials.
    allowedActorKinds: ["human", "machine"],
    lifecycleMarkers: [],
  },
  setTargetPrice: {
    key: "set_target_price",
    requestSchema: setBundleTargetPriceRequestSchema,
    gate: "mutation",
    // Append-only: a new price row is inserted and the previous active one closed.
    allowedActorKinds: ["human", "machine"],
    lifecycleMarkers: [],
  },
  archive: {
    key: "archive",
    requestSchema: archiveBundleRequestSchema,
    gate: "mutation",
    // Status flip, never a hard delete; reversible via restore, so agent-allowed.
    allowedActorKinds: ["human", "machine"],
    lifecycleMarkers: [],
  },
  restore: {
    key: "restore",
    requestSchema: restoreBundleRequestSchema,
    gate: "mutation",
    // Archived -> draft. Agent-allowed: the target is draft, so nothing becomes
    // sellable without a separate human activation.
    allowedActorKinds: ["human", "machine"],
    lifecycleMarkers: [],
  },
  cloneDraft: {
    key: "clone_draft",
    requestSchema: cloneBundleDraftRequestSchema,
    gate: "mutation",
    // Clone any bundle into a NEW draft under a new code, orchestrated through the
    // existing draft upsert. Born draft, so agent-allowed.
    allowedActorKinds: ["human", "machine"],
    lifecycleMarkers: [],
  },
  activate: {
    key: "activate",
    requestSchema: activateBundleRequestSchema,
    gate: "activation",
    // HUMAN-ONLY at TWO independent machine-checked layers: the handler factory
    // refuses a non-human actor (403, `actor_kind_not_allowed`) from this
    // `allowedActorKinds`, AND the activate routine RAISEs 42501
    // (`publish_requires_human`). Both re-derive the actor kind from the admin
    // registry rather than trusting the caller. The lifecycle marker additionally
    // makes the MCP generator drop the tool, so no agent surface can reach it.
    allowedActorKinds: ["human"],
    lifecycleMarkers: ["LIFECYCLE_ACTIVATE"],
  },
  deactivate: {
    key: "deactivate",
    requestSchema: deactivateBundleRequestSchema,
    gate: "activation",
    // Unpublish is the same class of transition as publish and is gated the same
    // way, at the same two layers, with the same structural absence from MCP.
    allowedActorKinds: ["human"],
    lifecycleMarkers: ["LIFECYCLE_DEACTIVATE"],
  },
};

/** Read operation keys; also the basis for the MCP tool names `bundle__*`. */
export type BundleQueryKey = "list" | "get" | "history" | "previewPrice";

/**
 * Reads carry no lifecycle marker and no actor-kind narrowing: an agent that may
 * compose and price a bundle must be able to read what it is about to change, and
 * a read leaves nothing behind. The publish transitions stay human-only because
 * they are writes, which is a different question from visibility.
 */
const queries: Record<BundleQueryKey, AgentDomainQuerySpec> = {
  list: {
    key: "list",
    requestSchema: listBundlesRequestSchema,
    gate: "read",
    allowedActorKinds: ["human", "machine"],
  },
  get: {
    key: "get",
    requestSchema: getBundleRequestSchema,
    gate: "read",
    allowedActorKinds: ["human", "machine"],
  },
  history: {
    key: "history",
    requestSchema: bundleHistoryRequestSchema,
    gate: "read",
    allowedActorKinds: ["human", "machine"],
  },
  previewPrice: {
    key: "preview_price",
    requestSchema: previewBundlePriceRequestSchema,
    gate: "read",
    // A price preview writes nothing: it is the pricing kernel run over today's
    // component prices, which is why it is a query rather than a dry-run mutation.
    allowedActorKinds: ["human", "machine"],
  },
};

export const bundleSpec: AgentDomainSpec<BundleId, BundleRuleCode, Record<string, unknown>> = {
  domainKey: "bundle",
  mutationFlag: BUNDLE_MUTATION_FLAG,
  activationFlag: BUNDLE_ACTIVATION_FLAG,
  readFlag: BUNDLE_READ_FLAG,
  idSchema: bundleCodeSchema,
  ruleCodes: BUNDLE_RULE_CODES,
  rules: evaluateBundleWriteRules,
  auditEntityType: "catalog_bundle",
  mutations,
  queries,
};
