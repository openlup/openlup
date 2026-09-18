import { describe, expect, it } from "vitest";

import { toolInputSchema } from "../_core/toolFromContract.js";
import {
  catalogHistoryRequestSchema,
  getCatalogProductRequestSchema,
  listCatalogProductsRequestSchema,
} from "../../src/domains/commerce/adminCatalogReadContracts.js";
import {
  getCatalogDocumentAuthorityRequestSchema,
  submitCatalogDocumentProposalRequestSchema,
} from "../../src/domains/commerce/adminCatalogDocumentContracts.js";
import { buildCatalogReadTools, buildCatalogTools } from "./tools.js";
import { catalogSpec } from "../../src/domains/commerce/catalogSpec.js";

const tools = buildCatalogTools();
const byName = new Map(tools.map((t) => [t.name, t]));

const readTools = buildCatalogReadTools();
const readByName = new Map(readTools.map((t) => [t.name, t]));

const allTools = [...tools, ...readTools];

/**
 * The three publication acts are human-only: they are `GRANT ... authenticated`,
 * they read `auth.uid()`, and no BFF route mounts them in any mode. Named here
 * as RPC names rather than tool names because the claim is that the MCP surface
 * cannot reach the ACT, however a future tool might spell it.
 */
const HUMAN_ONLY_PUBLICATION_RPCS = [
  "catalog_publish_candidate",
  "catalog_record_publication_decision",
  "catalog_rollback_publication",
] as const;

/**
 * Derived from the spec at runtime, minus the one key this wave publishes, so a
 * legacy mutation ADDED to `catalogSpec.mutations` later is covered without
 * anyone remembering to extend a hand-written list.
 */
const legacyMutationKeys = Object.values(catalogSpec.mutations)
  .map((mutation) => mutation.key)
  .filter((key) => key !== "propose_document");

describe("buildCatalogTools — the write surface is an allow-list of one", () => {
  it("emits exactly the two document-proposal tools, both POSTing the proposal route", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "catalog__validate_document",
      "catalog__propose_document",
    ]);
    for (const tool of tools) {
      expect(tool.path, tool.name).toBe("/api/bff/admin/commerce/catalog/document-proposal");
      // Absent httpMethod means POST; a write tool must never GET.
      expect(tool.httpMethod, tool.name).toBeUndefined();
      expect(tool.name).toMatch(/^[a-z]+__[a-z_]+$/);
      expect(tool.requestSchema).toBe(submitCatalogDocumentProposalRequestSchema);
      expect(tool.inputSchema).toEqual(toolInputSchema(submitCatalogDocumentProposalRequestSchema));
    }
  });

  /**
   * The trap this pins shut: `catalogSpec.mutations` is the domain's WHOLE write
   * surface, so a builder that maps over the record publishes every fenced
   * legacy write as an advertised agent tool. The allow-list is what stops it,
   * and this assertion is derived from the spec so a mutation added later is
   * already covered.
   */
  it("names no legacy catalog mutation, on either builder", () => {
    // Guard against the pin going vacuous: it proves something only while the
    // spec really does carry writes the MCP head withholds.
    expect(legacyMutationKeys.length).toBeGreaterThanOrEqual(9);
    expect(legacyMutationKeys).toContain("create_draft");

    const emitted = new Set(allTools.map((tool) => tool.name));
    for (const key of legacyMutationKeys) {
      expect(emitted.has(`${catalogSpec.domainKey}__${key}`), key).toBe(false);
    }
    for (const tool of allTools) {
      for (const key of legacyMutationKeys) {
        expect(tool.path, `${tool.name} -> ${key}`).not.toContain(key);
      }
    }
  });

  it("reaches no human-only publication act", () => {
    for (const rpc of HUMAN_ONLY_PUBLICATION_RPCS) {
      const asToolName = `${catalogSpec.domainKey}__${rpc.replace(/^catalog_/u, "")}`;
      for (const tool of allTools) {
        expect(tool.name, rpc).not.toBe(asToolName);
        expect(tool.name, rpc).not.toContain(rpc);
        expect(tool.path, rpc).not.toContain(rpc);
      }
    }
  });

  /**
   * Mode is forced by the transform, and the caller's input is spread FIRST so
   * the forced value wins. Reversed, an agent could pass `mode: "commit"` to the
   * tool whose description promises it writes nothing.
   */
  it("forces its mode over whatever the caller sent", () => {
    const expectedMode = {
      catalog__validate_document: "dry_run",
      catalog__propose_document: "commit",
    } as const;

    for (const [name, mode] of Object.entries(expectedMode)) {
      const transform = byName.get(name)?.transform;
      expect(transform, name).toBeTypeOf("function");
      for (const attempted of ["commit", "dry_run"] as const) {
        expect(transform?.({ mode: attempted }), `${name} <- ${attempted}`).toEqual({ mode });
      }
      // Everything else the caller sent survives untouched.
      expect(transform?.({ mode: "commit", baseDocumentDigests: [], candidate: { canonicalText: "{}" } })).toEqual({
        mode,
        baseDocumentDigests: [],
        candidate: { canonicalText: "{}" },
      });
    }
  });
});

describe("buildCatalogReadTools — read surface", () => {
  it("exposes exactly the four read tools, all GET", () => {
    expect(readTools.map((t) => t.name).sort()).toEqual([
      "catalog__get",
      "catalog__history",
      "catalog__list",
      "catalog__read_document",
    ]);
    for (const t of readTools) {
      expect(t.httpMethod).toBe("GET");
      expect(t.name).toMatch(/^[a-z]+__[a-z_]+$/);
    }
  });

  it("read tool input schemas are derived projections of the read contracts", () => {
    expect(readByName.get("catalog__list")?.requestSchema).toBe(listCatalogProductsRequestSchema);
    expect(readByName.get("catalog__list")?.inputSchema).toEqual(
      toolInputSchema(listCatalogProductsRequestSchema),
    );
    expect(readByName.get("catalog__get")?.inputSchema).toEqual(
      toolInputSchema(getCatalogProductRequestSchema),
    );
    expect(readByName.get("catalog__history")?.inputSchema).toEqual(
      toolInputSchema(catalogHistoryRequestSchema),
    );
    expect(readByName.get("catalog__read_document")?.inputSchema).toEqual(
      toolInputSchema(getCatalogDocumentAuthorityRequestSchema),
    );
  });

  it("read tools GET their read routes", () => {
    expect(readByName.get("catalog__list")?.path).toBe("/api/bff/admin/commerce/catalog/list");
    expect(readByName.get("catalog__get")?.path).toBe("/api/bff/admin/commerce/catalog/get");
    expect(readByName.get("catalog__history")?.path).toBe("/api/bff/admin/commerce/catalog/history");
    expect(readByName.get("catalog__read_document")?.path).toBe(
      "/api/bff/admin/commerce/catalog/document",
    );
  });

  it("the local stdio catalog surface is exactly its four reads plus validate and propose", () => {
    expect(allTools.map((t) => t.name).sort()).toEqual([
      "catalog__get",
      "catalog__history",
      "catalog__list",
      "catalog__propose_document",
      "catalog__read_document",
      "catalog__validate_document",
    ]);
  });
});

/**
 * The trap this pins shut: `buildCatalogReadTools` iterates the WHOLE
 * `catalogSpec.queries` record, so a wave that adds a read to the domain used to
 * publish an MCP tool by accident - with `path: undefined`, because it had no
 * entry in the path map. W3f-a hit exactly that when it added the `document`
 * query. The path/description maps are the allow-list; the spec is not.
 *
 * W3f-c published that query, so the allow-list is now saturated and there is no
 * withheld read left to demonstrate the skip with. What still holds the line is
 * the pair below: an emitted tool must resolve to a real spec query AND to a
 * mapped route, and the emitted SET is frozen - so the next wave that maps a new
 * query has to change this file deliberately rather than gain a tool silently.
 */
describe("the read allow-list, not the spec, decides the MCP surface", () => {
  it("emits only spec queries, and only ones carrying a mapped route and description", () => {
    const queryKeys = new Set(Object.values(catalogSpec.queries ?? {}).map((query) => query.key));
    expect(queryKeys.size).toBeGreaterThan(0);

    for (const tool of readTools) {
      const key = tool.name.slice(`${catalogSpec.domainKey}__`.length);
      expect([...queryKeys], tool.name).toContain(key);
      expect(tool.path, tool.name).toMatch(/^\/api\/bff\/admin\/commerce\/catalog\//);
      expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(0);
    }
    expect(readTools.length).toBe(queryKeys.size);
  });

  it("emits no tool with an undefined path or description", () => {
    for (const tool of allTools) {
      expect(tool.path, tool.name).toMatch(/^\/api\/bff\//);
      expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(0);
    }
  });
});
