import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createCapturedTransactionalDelivery } from "./transactionalDelivery.js";

const command = {
  idempotencyKey: "delivery:attempt-1",
  recipientReference: "recipient-1",
  templateReference: "template-1",
};

describe("captured transactional delivery adapter", () => {
  it("returns a deterministic opaque reference without egress", async () => {
    await expect(createCapturedTransactionalDelivery().deliver(command))
      .resolves.toEqual({
        deliveryReference: `captured:${createHash("sha256").update(command.idempotencyKey).digest("hex")}`,
      });
  });

  it("allows a bounded outcome seam to prove failure then recovery", async () => {
    const outcome = vi.fn()
      .mockResolvedValueOnce({ state: "failed" as const })
      .mockResolvedValueOnce({ state: "accepted" as const, deliveryReference: "captured:recovered" });
    const adapter = createCapturedTransactionalDelivery({ outcome });

    await expect(adapter.deliver(command)).rejects.toThrow("captured_delivery_failed");
    await expect(adapter.deliver(command)).resolves.toEqual({ deliveryReference: "captured:recovered" });
    expect(outcome).toHaveBeenCalledTimes(2);
  });

  it("keeps the default reference valid at the maximum command-key length", async () => {
    const result = await createCapturedTransactionalDelivery().deliver({
      ...command,
      idempotencyKey: "a".repeat(256),
    });
    expect(result.deliveryReference).toHaveLength(73);
    expect(result.deliveryReference).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
  });
});
