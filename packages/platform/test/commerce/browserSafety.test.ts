import { build, type Metafile } from "esbuild";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const serverExports = [
  "addCommerceOmsNote",
  "authorize",
  "buildOmsOrderDetailResponse",
  "callOmsRpc",
  "createAdminCommerceOrderCancelHandler",
  "createAdminCommerceOrderDetailHandler",
  "createAdminCommerceOrderHoldHandler",
  "createAdminCommerceOrderMarkRefundedHandler",
  "createAdminCommerceOrderNoteHandler",
  "createAdminCommerceOrderReleaseHoldHandler",
  "createAdminCommerceOrderUpdateShippingAddressHandler",
  "createAdminCommerceOrdersListHandler",
  "createAdminReturnApproveHandler",
  "createAdminReturnRejectHandler",
  "createCommerceOmsControlPlaneDetailHandler",
  "createCommerceOmsControlPlaneListHandler",
  "createCustomerReturnRequestHandler",
  "createManagedCommerceOmsControlPlanePort",
  "createManagedCommerceOmsPort",
  "createOrderReviewAdminHandlers",
  "createOrderReviewHandlers",
  "createOrderReviewRawUploadHandler",
  "createPostgresOrderReviewAdminReadPort",
  "createPostgresOrderReviewLifecyclePort",
  "createPostgresOrderReviewMediaPort",
  "createSupabaseCommerceReturnsPort",
  "createSupabaseOrderFeedbackSubmitPort",
  "createSupabaseOrderFeedbackTokenCheckPort",
  "distinctIds",
  "emptyOmsManagedReadProjections",
  "getCommerceOmsOrderDetail",
  "getCommerceOmsOrderDetails",
  "inspectImageHeader",
  "isOptionalProviderEvidenceColumnError",
  "listCommerceOmsOrders",
  "mapReplacementRefusal",
  "mapRpcError",
  "parseOmsRequest",
  "readAccountingOutbox",
  "readActivePaymentAttempts",
  "readFulfillmentOrdersByOrderIds",
  "readFulfillmentParcelsByOrderId",
  "readOmsInboundEvents",
  "readOrderPaidOutboxEvents",
  "readQueueSelection",
  "readShipmentRefsByOrderId",
  "readShipmentRefsByOrderIds",
  "sendOmsMutationResponse",
  "unprojectedOmsReadGate",
  "updateCommerceOmsShippingAddress"
].sort();

function bundle(entry: URL, platform: "browser" | "node") {
  return build({
    entryPoints: [fileURLToPath(entry)], bundle: true, platform, format: "esm",
    write: false, metafile: true, logLevel: "silent",
  });
}

function expectBrowserGraph(metafile: Metafile) {
  for (const [path, input] of Object.entries(metafile.inputs)) {
    expect(path).not.toMatch(/(?:^|[/\\])commerce[/\\]server[/\\]/);
    for (const name of [path, ...input.imports.map(({ path }) => path)]) {
      expect(name).not.toMatch(/^(?:node:|pg(?:\/|$))|(?:^|[/\\])node_modules[/\\]pg(?:[/\\]|$)/);
    }
  }
}

describe("commerce runtime placement", () => {
  it("bundles the complete published commerce entry for browsers without externals", async () => {
    const result = await bundle(new URL("../../dist/commerce/index.js", import.meta.url), "browser");
    expectBrowserGraph(result.metafile);
    for (const output of Object.values(result.metafile.outputs)) {
      for (const name of serverExports) expect(output.exports).not.toContain(name);
    }
  });

  it.each(["orderReviewContracts", "orderFeedbackContracts"])("bundles the reference %s facade for browsers", async (name) => {
    const result = await bundle(new URL(`../../../../src/domains/commerce/${name}.ts`, import.meta.url), "browser");
    expectBrowserGraph(result.metafile);
  });

  it("bundles the complete server entry for Node with only the public server exports", async () => {
    const result = await bundle(new URL("../../dist/commerce/server/index.js", import.meta.url), "node");
    expect(Object.values(result.metafile.outputs).flatMap(({ exports }) => exports).sort()).toEqual(serverExports);
  });

  it("refuses raw upload in a browser as a live negative control", async () => {
    await expect(bundle(new URL("../../src/commerce/server/orderReviewRawUploadHandler.ts", import.meta.url), "browser"))
      .rejects.toMatchObject({ errors: expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("node:crypto") }),
        expect.objectContaining({ text: expect.stringContaining("node:zlib") }),
      ]) });
  });
});
