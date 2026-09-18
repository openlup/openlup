import { describe, expect, it } from "vitest";

import { toolInputSchema } from "../_core/toolFromContract.js";
import {
  createBundleDraftRequestSchema,
  setBundleCompositionRequestSchema,
  setBundleTargetPriceRequestSchema,
  updateBundleDraftRequestSchema,
} from "../../src/domains/bundle/adminBundleContracts.js";
import { bundleSpec } from "../../src/domains/bundle/bundleSpec.js";
import { buildBundleTools } from "./tools.js";

const tools = buildBundleTools();
const byName = new Map(tools.map((tool) => [tool.name, tool]));

describe("buildBundleTools — tool surface", () => {
  it("exposes exactly the draft-only bundle tools", () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "bundle__archive",
      "bundle__clone_draft",
      "bundle__create_draft",
      "bundle__restore",
      "bundle__set_composition",
      "bundle__set_target_price",
      "bundle__update_draft",
      "bundle__validate",
    ]);
  });

  it("structurally excludes every mutation carrying a lifecycle marker (activate + deactivate)", () => {
    const droppedKeys = Object.values(bundleSpec.mutations)
      .filter((mutation) => mutation.lifecycleMarkers.length > 0)
      .map((mutation) => mutation.key);
    expect(droppedKeys.sort()).toEqual(["activate", "deactivate"]);
    for (const key of droppedKeys) {
      expect(byName.has(`bundle__${key}`)).toBe(false);
    }
  });

  it("never exposes a publish or unpublish tool on the agent surface", () => {
    expect(byName.has("bundle__activate")).toBe(false);
    expect(byName.has("bundle__deactivate")).toBe(false);
    expect(
      tools.some((tool) => /activate|deactivate|publish|unpublish|delete/.test(tool.name)),
    ).toBe(false);
  });

  it("carries no publish route at all, so a careless edit cannot find one", () => {
    // The exclusion is the absence of a path, not a filter over paths: no tool on
    // this surface may point at the activation routes even by accident.
    for (const tool of tools) {
      expect(tool.path).not.toMatch(/\/(activate|deactivate)$/);
    }
  });

  it("every tool name matches the MCP naming convention", () => {
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z]+__[a-z_]+$/);
    }
  });
});

describe("buildBundleTools — schemas are derived projections of the write contracts", () => {
  it("create_draft input schema is the create contract, derived (never hand-authored)", () => {
    const create = byName.get("bundle__create_draft");
    expect(create?.requestSchema).toBe(createBundleDraftRequestSchema);
    expect(create?.inputSchema).toEqual(toolInputSchema(createBundleDraftRequestSchema));
  });

  it("update, composition and price input schemas equal their derived contracts", () => {
    expect(byName.get("bundle__update_draft")?.inputSchema).toEqual(
      toolInputSchema(updateBundleDraftRequestSchema),
    );
    expect(byName.get("bundle__set_composition")?.inputSchema).toEqual(
      toolInputSchema(setBundleCompositionRequestSchema),
    );
    expect(byName.get("bundle__set_target_price")?.inputSchema).toEqual(
      toolInputSchema(setBundleTargetPriceRequestSchema),
    );
  });

  it("validate dry-runs the create contract: forces mode=dry_run, posts to create", () => {
    const validate = byName.get("bundle__validate");
    expect(validate?.path).toBe("/api/bff/admin/commerce/bundles/create");
    expect(validate?.inputSchema).toEqual(toolInputSchema(createBundleDraftRequestSchema));
    expect(validate?.transform?.({ mode: "commit", bundle: {} })).toEqual({
      mode: "dry_run",
      bundle: {},
    });
  });

  it("each write tool posts to its own route", () => {
    expect(byName.get("bundle__create_draft")?.path).toBe(
      "/api/bff/admin/commerce/bundles/create",
    );
    expect(byName.get("bundle__update_draft")?.path).toBe(
      "/api/bff/admin/commerce/bundles/update",
    );
    expect(byName.get("bundle__set_composition")?.path).toBe(
      "/api/bff/admin/commerce/bundles/set-composition",
    );
    expect(byName.get("bundle__set_target_price")?.path).toBe(
      "/api/bff/admin/commerce/bundles/set-target-price",
    );
    expect(byName.get("bundle__archive")?.path).toBe("/api/bff/admin/commerce/bundles/archive");
    expect(byName.get("bundle__restore")?.path).toBe("/api/bff/admin/commerce/bundles/restore");
    expect(byName.get("bundle__clone_draft")?.path).toBe(
      "/api/bff/admin/commerce/bundles/clone-draft",
    );
  });
});
