import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, expectTypeOf, it } from "vitest";
import { platformOwnsBuyerEmail, projectCommerceSalesChannelEnvelope, type CommerceChannelExposureReadPort } from "../../../src/commerce/index.js";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const commerce = join(root, "packages/platform/src/commerce");
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? sources(join(directory, entry.name)) : entry.name.endsWith(".ts") && !/\.(test|spec|fixture)\.ts$/.test(entry.name)
      ? [join(directory, entry.name)] : []);
}

describe("neutral sales-channel envelope (W9)", () => {
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
