import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PgQueryExecutor } from "@openlup/platform/data";
import { expect, it, vi } from "vitest";
import { PAYMENT_MIGRATIONS, createPostgresPaymentTruthPort, paymentSchemaDescriptor } from "@openlup/platform/payments";

it("binds canonical sparse SQL identities and preserves native readback and unknown behavior", async () => {
  expect(PAYMENT_MIGRATIONS.map(unit => unit.position)).toEqual([10, 35, 56]);
  for (const unit of PAYMENT_MIGRATIONS) {
    const bytes = readFileSync(new URL(`../../../../${unit.catalogPath}`, import.meta.url));
    expect(readFileSync(unit.url)).toEqual(bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(unit.sha256);
  }
  const query = vi.fn(async () => ({ rows: [{ response: null }] }));
  const executor: PgQueryExecutor = { query };
  const store = createPostgresPaymentTruthPort(executor, {
    dunningTemplateSlug: "payment_failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "payment_recovered",
  });
  expect(await store.readEvent("00000000-0000-4000-8000-000000000000")).toBeNull();
  expect(query.mock.calls).toHaveLength(1);
  expect(paymentSchemaDescriptor).toMatchObject({ truth: "supported", settlement: "supported", laterOnlyCycle: "supported" });
});

it.each(["preparedDurableStore", "methodSetup", "absenceReopen", "cumulativeRefund"] as const)("refuses the unsupported direct operation %s", operation => {
  // Explicit refusal at the schema capability boundary; no writer is offered.
  expect(paymentSchemaDescriptor[operation]).toBe("unsupported");
});
