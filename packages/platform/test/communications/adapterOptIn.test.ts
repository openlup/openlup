import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
it("P3 case 6: neutral and browser entries isolate adapters and binding imports stay inert", async () => {
  const fetcher = vi.fn(() => { throw Error("ambient network forbidden"); });
  vi.stubGlobal("fetch", fetcher);
  const neutral = await import("../../src/communications/index.js");
  const browser = await import("../../src/communications/contracts/index.js");
  for (const surface of [neutral, browser]) {
    for (const key of ["createResendTransport", "createResendWebhookHandler", "runResendDeliveryReconciliation", "createKlaviyoMarketingAdapter", "createA1ReferenceBinding"]) expect(surface).not.toHaveProperty(key);
  }
  const bindingUrl = new URL("../../../../server/runtime/communications/a1ReferenceBinding.ts", import.meta.url);
  const source = readFileSync(bindingUrl, "utf8");
  expect(source).not.toMatch(/process\.env|import\.meta\.env|setInterval|setTimeout/);
  // A fresh process has no optional peer or checkout-resolution assistance (case 7).
  const binding = await import(/* @vite-ignore */ bindingUrl.href);
  expect(await binding.createA1ReferenceBinding()).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
});
