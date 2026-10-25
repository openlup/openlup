/*
 * Adopter-private assertions not carried over:
 * - Two exposure/new-purchase migration SHA seals, witnessed-object catalog and `assertMigrationWitness`:
 *   adopter append-only lineage, owned by M10/M06.
 * - `inventory_listing_exposure(p_sku_id uuid)` declaration regex: M10/M06 exposure SQL.
 * - Issued-minus-converted-minus-withdrawn listing-unit SQL text: M10/M06 exposure SQL.
 * - Raw-sellable-minus-listing-exposure regex: M10/M06 ATP/exposure SQL.
 * - Pending-symbol migration-lineage absence: replaced by package-source absence of
 *   `inventory_channel_exposure_quantity` and a type-only injected exposure-read port.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, expectTypeOf, it } from "vitest";
import { platformOwnsBuyerEmail, projectCommerceSalesChannelEnvelope, type CommerceChannelExposureReadPort } from "../../../src/commerce/index.js";
import { buildOmsOrderListResponse, buildOmsOrderDetailResponse, type OmsOrderRow } from "../../../src/commerce/model/omsReadModel.js";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const commerce = join(root, "packages/platform/src/commerce");
const order: OmsOrderRow = {
  id: "11111111-1111-4111-8111-111111111111", order_number: "ORDER-1",
  client_id: "22222222-2222-4222-8222-222222222222", status: "paid", mode: "one_time", currency: "XXX",
  subtotal_cents: 100, discount_cents: 0, shipping_cents: 0, shipping_discount_cents: 0, tax_cents: 0, total_cents: 100,
  metadata: null, created_at: "2026-10-22T10:00:00Z", updated_at: "2026-10-22T10:00:00Z",
  subscription_id: null, subscription_cycle_id: null, shipping_address_id: null,
  source_kind: "marketplace", source_order_ref: "external:Case-Sensitive/00007", sales_channels: { slug: "external-example" },
};
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? sources(join(directory, entry.name)) : entry.name.endsWith(".ts") && !/\.(test|spec|fixture)\.ts$/.test(entry.name)
      ? [join(directory, entry.name)] : []);
}

describe("neutral sales-channel envelope (W9)", () => {
  it("retains opaque source identity byte-exact through the real OMS list projection", () => {
    const list = buildOmsOrderListResponse({ orders: [order], paymentIntents: [], paymentAttempts: [],
      activeHoldCounts: {}, totalCount: 1, page: 1, pageSize: 25 });
    expect(list.orders[0]).toMatchObject({ sourceKind: "marketplace", sourceChannelSlug: "external-example",
      sourceOrderRef: "external:Case-Sensitive/00007" });
  });

  it("retains opaque source identity byte-exact through the real OMS detail projection", () => {
    const detail = buildOmsOrderDetailResponse({ order, paymentIntent: null, paymentAttempts: [], paymentTransitions: [],
      holds: [], operations: [], subscriptionCycleStatus: null });
    expect(detail.order).toMatchObject({ sourceKind: "marketplace", sourceChannelSlug: "external-example",
      sourceOrderRef: "external:Case-Sensitive/00007" });
  });

  it("retains opaque identity byte-exact through the projection used by later OMS bindings", () => {
    expect(projectCommerceSalesChannelEnvelope({ source_kind: "external", source_order_ref: "external:Case-Sensitive/00007",
      sales_channels: { slug: "external-example" } })).toEqual({ sourceKind: "external", sourceChannelSlug: "external-example",
      sourceOrderRef: "external:Case-Sensitive/00007" });
    expect(projectCommerceSalesChannelEnvelope({ source_kind: " External ", source_order_ref: "  external:Case-Sensitive/00007  ",
      sales_channels: { slug: " Channel-A " } })).toEqual({ sourceKind: " External ", sourceChannelSlug: " Channel-A ",
      sourceOrderRef: "  external:Case-Sensitive/00007  " });
    expect(projectCommerceSalesChannelEnvelope({})).toEqual({ sourceKind: null, sourceChannelSlug: null, sourceOrderRef: null });
    expect(platformOwnsBuyerEmail(null)).toBe(true);
    expect(platformOwnsBuyerEmail({ sourceKind: "opaque", buyerCommsOwner: "channel" })).toBe(false);
    expect(platformOwnsBuyerEmail({ sourceKind: "opaque", buyerCommsOwner: "future-owner" })).toBe(true);
  });

  it("keeps every commerce source import/export and literal loader free of channel and adapter bindings", () => {
    const paths = sources(commerce);
    expect(paths.length).toBeGreaterThan(40);
    const adapterNames = readdirSync(join(root, "server/adapters"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const violations: string[] = [];
    for (const path of paths) {
      const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        let specifier: string | undefined;
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          specifier = node.moduleSpecifier.text;
        }
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require")
          && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specifier = node.arguments[0].text;
        if (specifier) {
          const target = (specifier.startsWith(".") ? relative(root, resolve(dirname(path), specifier))
            : specifier.replace(/^@\//, "src/")).split(sep).join("/");
          // K3a owns this neutral managed-adapter root; remaining donor names still refuse.
          const adapterTarget = target.replace(/^packages\/platform\/src\/commerce\/adapters\/managed\//, "commerce/");
          if (/(?:^|\/)src\/domains\/channels(?:\/|$)|(?:^|\/)server\/adapters(?:\/|$)/.test(target)
            || adapterTarget.replace(/^packages\/platform\/src\//, "").replace(/^@openlup\/platform(?:\/|$)/, "").split("/").some((part) => adapterNames.includes(part))) violations.push(`${relative(root, path)}:${specifier}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(violations).toEqual([]);
  });

  it("accepts only an injected inventory exposure read and defines no exposure SQL", async () => {
    const signal = new AbortController().signal;
    const readExposure: CommerceChannelExposureReadPort = async (skuId, receivedSignal) => {
      expect(skuId).toBe("sku-opaque"); expect(receivedSignal).toBe(signal); return 7;
    };
    expectTypeOf<CommerceChannelExposureReadPort>().toEqualTypeOf<(skuId: string, signal: AbortSignal) => Promise<number>>();
    expect(await readExposure("sku-opaque", signal)).toBe(7);
    const all = sources(join(root, "packages/platform/src"));
    expect(all.length).toBeGreaterThan(100);
    expect(all.filter((path) => readFileSync(path, "utf8").includes("inventory_channel_exposure_quantity"))).toEqual([]);
  });
});
