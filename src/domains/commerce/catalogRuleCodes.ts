/**
 * @agent-domain-reference
 * REFERENCE IMPLEMENTATION — the canonical agent-operable domain. New domains
 * copy this shape (see `mcp/PLAYBOOK.md`, Wave 5). Do NOT treat Promotions as
 * the reference — it is a back-compat harness (`@agent-domain-anti-reference`).
 *
 * Catalog write rules — the named, enforced business invariants of the
 * agent-operable catalog write path. These codes are the single vocabulary
 * shared by: the request contracts, the pure rule predicates (`catalogRules.ts`),
 * the service-role RPCs (which RAISE them), and the over-the-wire error taxonomy.
 * The lifecycle subset is now expressed via the generic kit
 * (`src/lib/agent-domain/`); the codes stay here as the domain's registry.
 */

import type { RuleResult } from "../../lib/agent-domain/ruleResult.js";
import type { AgentActorKind } from "../../lib/agent-domain/ruleResult.js";

export const CATALOG_RULE_CODES = [
  // Activation (draft -> active) requires the SKU to have an active price_entry.
  // Enforced in the activate RPC (DB-stateful).
  "PRICE_REQUIRED_TO_SELL",
  // Machine (agent) actors may create/update drafts, set prices and archive, but
  // may NOT activate. Enforced in the handler (allowedActorKinds) AND re-derived
  // + RAISEd in the activate RPC.
  "DRAFT_ONLY_FOR_MACHINE",
  // Products/SKUs referenced by an order/draft/subscription are never hard-deleted;
  // removal is an archive (status flip). Enforced in the archive RPC.
  "NO_HARD_DELETE",
  // Price changes INSERT a new price_entries row + deactivate the old one; an
  // existing row is never mutated in place. Enforced in the set-price RPC.
  "APPEND_ONLY_PRICE",
  // Creating a product with an already-used slug is rejected. Enforced in the
  // upsert RPC (unique slug).
  "SLUG_TAKEN",
  // Restore is the inverse of archive: it only applies to an ARCHIVED product
  // (target draft makes nothing sellable). Enforced in the restore RPC (P0001).
  "RESTORE_REQUIRES_ARCHIVED",
  // Deactivate (unpublish, active -> draft) only applies to a LIVE product.
  // Enforced in the deactivate RPC (P0001).
  "DEACTIVATE_REQUIRES_ACTIVE",
  // Clone reads its source via the read path; a missing source is rejected before
  // the upsert replay. Enforced in the clone BFF orchestration (NOT_FOUND, P0002).
  "CLONE_SOURCE_NOT_FOUND",
] as const;

export type CatalogRuleCode = (typeof CATALOG_RULE_CODES)[number];

/** Which rules are checkable from the request alone (pure, pre-flight) vs which
 *  are DB-stateful and authoritatively enforced in the RPC. Documents intent and
 *  keeps the handler honest about what it can/can't decide before the RPC. */
export const CATALOG_RULE_ENFORCEMENT: Record<
  CatalogRuleCode,
  "request" | "rpc"
> = {
  DRAFT_ONLY_FOR_MACHINE: "request", // actorKind + operation are known pre-RPC
  PRICE_REQUIRED_TO_SELL: "rpc",
  NO_HARD_DELETE: "rpc",
  APPEND_ONLY_PRICE: "rpc",
  SLUG_TAKEN: "rpc",
  RESTORE_REQUIRES_ARCHIVED: "rpc",
  DEACTIVATE_REQUIRES_ACTIVE: "rpc",
  CLONE_SOURCE_NOT_FOUND: "rpc",
};

export type CatalogActorKind = AgentActorKind;

export type CatalogWriteOperation =
  | "create_draft"
  | "update_draft"
  | "set_price"
  | "archive"
  | "activate"
  | "archive_product"
  | "restore"
  | "clone_draft"
  | "deactivate";

/** The domain's rule result, projected from the generic kit `RuleResult`. */
export type CatalogRuleResult = RuleResult<CatalogRuleCode>;
