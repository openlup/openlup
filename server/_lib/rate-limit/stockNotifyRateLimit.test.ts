import { describe, expect, it, vi } from "vitest";
import { checkAndRecordStockNotifyAttempt } from "./stockNotifyRateLimit.js";

describe("stock notify rate limit", () => {
  it("allows attempts returned by the durable limiter RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { allowed: true, attempts_by_ip: 1, attempts_by_email_sku: 1 },
      error: null,
    });

    const result = await checkAndRecordStockNotifyAttempt({
      client: { rpc },
      ip: "203.0.113.1",
      email: "buyer@example.com",
      sku: "OPENLUP-LAMB-5KG",
    });

    expect(result).toEqual({
      allowed: true,
      attemptsByIp: 1,
      attemptsByEmailSku: 1,
      reason: undefined,
    });
    expect(rpc).toHaveBeenCalledWith(
      "commerce_record_stock_notify_attempt",
      expect.objectContaining({
        p_window_minutes: 60,
        p_max_per_ip: 20,
        p_max_per_email_sku: 3,
      }),
    );
  });

  it("denies repeated email+SKU attempts independently of IP quota", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { allowed: false, reason: "email_sku_quota", attempts_by_ip: 2, attempts_by_email_sku: 3 },
      error: null,
    });

    await expect(checkAndRecordStockNotifyAttempt({
      client: { rpc },
      ip: "203.0.113.1",
      email: "buyer@example.com",
      sku: "OPENLUP-LAMB-5KG",
    })).resolves.toMatchObject({
      allowed: false,
      reason: "email_sku_quota",
      attemptsByIp: 2,
      attemptsByEmailSku: 3,
    });
  });

  it("fails closed when the durable limiter is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "missing function" } });

    await expect(checkAndRecordStockNotifyAttempt({
      client: { rpc },
      ip: "203.0.113.1",
      email: "buyer@example.com",
      sku: "OPENLUP-LAMB-5KG",
    })).resolves.toMatchObject({
      allowed: false,
      reason: "limiter_unavailable",
    });

    warn.mockRestore();
  });
});
