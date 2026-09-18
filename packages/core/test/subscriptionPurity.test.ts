import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("subscription engine purity", () => {
  it("stays free of IO, timers, database clients, and payment ports", () => {
    const source = [
      "index.ts",
      "subscriptionEngineCore.ts",
      "subscriptionEngineLifecycle.ts",
      "subscriptionEnginePayment.ts",
      "subscriptionEngineUtils.ts",
    ]
      .map((file) => readFileSync(join(process.cwd(), "src/subscription", file), "utf8"))
      .join("\n");

    expect(source).not.toMatch(/fetch\(/);
    expect(source).not.toMatch(/createClient/);
    expect(source).not.toMatch(/supabase/i);
    expect(source).not.toMatch(/setTimeout|setInterval/);
    expect(source).not.toMatch(/PaymentPort/);
  });
});
