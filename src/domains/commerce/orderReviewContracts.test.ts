import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import * as facade from "./orderReviewContracts.js";
import * as commerce from "@openlup/platform/commerce";
it("preserves package export identity", () => {
  expect(Object.keys(facade).sort()).toEqual(["ORDER_REVIEW_CONTRACT_VERSION", "orderReviewAdminDetailSchema", "orderReviewAdminRevokeSchema", "orderReviewCommandKeySchema", "orderReviewContentTypeSchema", "orderReviewCustomerCommandSchema", "orderReviewCustomerResultSchema", "orderReviewFailure", "orderReviewGrantReferenceSchema", "orderReviewMediaConfirmSchema", "orderReviewMediaIntentResultSchema", "orderReviewMediaIntentSchema", "orderReviewMediaReferenceSchema", "orderReviewMediaSchema", "orderReviewModerationSchema", "orderReviewReadResultSchema", "orderReviewReferenceSchema", "orderReviewSchema", "orderReviewSubmitSchema", "orderReviewUploadCapabilitySchema"]);
  for (const [name, value] of Object.entries(facade)) {
    expect(value).toBe(commerce[name as keyof typeof commerce]);
  }
});

// BASE review contracts and donor hosted-feedback contracts use the browser
// wrapper and produce zero Function probes in a fresh process under strict CSP.
// Each child starts without the parent test registry's global Zod configuration.
function functionProbes(moduleUrl: string): number {
  const source = `
    import { registerHooks } from "node:module";
    import { existsSync } from "node:fs";
    import { fileURLToPath } from "node:url";
    registerHooks({ resolve(specifier, context, next) {
      try { return next(specifier, context); }
      catch (error) {
        if (specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
          const url = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
          if (existsSync(fileURLToPath(url))) return next(url.href, context);
        }
        throw error;
      }
    } });
    let probes = 0;
    const blocked = () => { probes++; throw new EvalError("strict CSP"); };
    globalThis.Function = new Proxy(globalThis.Function, { construct: blocked, apply: blocked });
    const contracts = await import(${JSON.stringify(moduleUrl)});
    contracts.orderReviewReadResultSchema?.parse({ review: null, media: [] });
    contracts.orderFeedbackTokenCheckRequestSchema?.parse({ token: "opaque-token" });
    process.stdout.write(JSON.stringify(probes));
  `;
  return JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], {
    encoding: "utf8", timeout: 10_000,
  }));
}

it.each(["orderReviewContracts", "orderFeedbackContracts"])("initializes %s without a Function probe in a fresh process", (name) => {
  expect(functionProbes(new URL(`./${name}.ts`, import.meta.url).href)).toBe(0);
});

it.each(["orderReviewContracts", "orderFeedbackContracts"])("detects the CSP probe if %s bypasses the browser wrapper", (name) => {
  expect(functionProbes(new URL(`../../../packages/platform/src/commerce/${name}.ts`, import.meta.url).href)).toBe(1);
});
