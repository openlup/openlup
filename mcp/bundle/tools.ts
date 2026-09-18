import { createBundleDraftRequestSchema } from "../../src/domains/bundle/adminBundleContracts.js";
import { bundleSpec } from "../../src/domains/bundle/bundleSpec.js";
import { toolInputSchema, type McpToolDefinition } from "../_core/toolFromContract.js";

/**
 * MCP agent head — bundle domain tool list.
 *
 * The tools are PROJECTIONS of `bundleSpec`: one per mutation, derived from the
 * same request contract the BFF validates against. The two publish-state
 * mutations carry lifecycle markers, so the generator DROPS them — agents compose
 * and price bundles but cannot put one on sale or take it off sale, and there is
 * structurally no tool that could. (Both routines also RAISE 42501 for a machine
 * actor; defence in depth.) A `bundle__validate` tool dry-runs the create contract.
 */
const BUNDLE_BFF_BASE = "/api/bff/admin/commerce/bundles";

/**
 * BFF route path per spec operation key — DRAFT-ONLY operations only. The
 * activate and deactivate routes are deliberately ABSENT: this file must stay
 * publish-blind, so the paths simply do not exist here. Even a careless later edit
 * that iterates these keys without re-checking `lifecycleMarkers` cannot find a
 * publish route to call.
 */
const BFF_PATH_BY_KEY: Record<string, string> = {
  create_draft: `${BUNDLE_BFF_BASE}/create`,
  update_draft: `${BUNDLE_BFF_BASE}/update`,
  set_composition: `${BUNDLE_BFF_BASE}/set-composition`,
  set_target_price: `${BUNDLE_BFF_BASE}/set-target-price`,
  archive: `${BUNDLE_BFF_BASE}/archive`,
  restore: `${BUNDLE_BFF_BASE}/restore`,
  clone_draft: `${BUNDLE_BFF_BASE}/clone-draft`,
  // NOTE: `activate` and `deactivate` are deliberately ABSENT.
};

const DESCRIPTION_BY_KEY: Record<string, string> = {
  create_draft:
    "Create a DRAFT bundle: a set of catalogue units sold under one operator-set price. Draft-only: it is not sellable until a human activates it.",
  update_draft:
    "Update structural fields on an existing DRAFT bundle. Draft-only: it does not publish the bundle.",
  set_composition:
    "Replace a bundle's whole bill of materials in one atomic write. Needs at least one component and at least one that is not an add-on; a unit may appear once, with its multiplicity as the quantity.",
  set_target_price:
    "Append an active target price for the whole bundle (append-only; prior prices are retained and closed). The target may not exceed the sum of the components.",
  archive: "Archive a bundle (soft, never hard-delete). An archived bundle stops being sellable.",
  restore:
    "Restore an archived bundle back to DRAFT. Draft-only: nothing becomes sellable until a human re-activates it.",
  clone_draft:
    "Clone an existing bundle (any status) into a NEW DRAFT under a new code, including its whole bill of materials. Draft-only.",
};

export function buildBundleTools(): McpToolDefinition[] {
  const tools: McpToolDefinition[] = [];

  for (const mutation of Object.values(bundleSpec.mutations)) {
    // Draft-only head: drop every mutation carrying a lifecycle marker. This is
    // the structural exclusion, not a filter someone can forget to apply.
    if (mutation.lifecycleMarkers.length > 0) continue;
    tools.push({
      name: `${bundleSpec.domainKey}__${mutation.key}`,
      description: DESCRIPTION_BY_KEY[mutation.key] ?? `Bundle ${mutation.key}`,
      path: BFF_PATH_BY_KEY[mutation.key],
      requestSchema: mutation.requestSchema,
      inputSchema: toolInputSchema(mutation.requestSchema),
    });
  }

  // Dry-run validator over the create contract: full rule pass, zero writes.
  tools.push({
    name: `${bundleSpec.domainKey}__validate`,
    description:
      "Validate a draft-bundle create payload without persisting it (dry run). Returns the rule checks that would apply.",
    path: BFF_PATH_BY_KEY.create_draft,
    requestSchema: createBundleDraftRequestSchema,
    inputSchema: toolInputSchema(createBundleDraftRequestSchema),
    transform: (input) => ({ ...input, mode: "dry_run" }),
  });

  return tools;
}
