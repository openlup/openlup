import { afterEach, describe, expect, it, vi } from "vitest";
import { logEmailLedgerInsertFailure } from "./emailLedgerLog.ts";

afterEach(() => vi.restoreAllMocks());

describe("logEmailLedgerInsertFailure", () => {
  it("emits one uniform, greppable event code with serialized PostgREST error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logEmailLedgerInsertFailure({
      source: "outbox-dispatch",
      templateSlug: "commerce-order-paid",
      error: { code: "23505", message: "duplicate key" },
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const [code, payload] = spy.mock.calls[0] as [string, string];
    expect(code).toBe("email_ledger_insert_failed");
    const parsed = JSON.parse(payload);
    expect(parsed).toMatchObject({ source: "outbox-dispatch", templateSlug: "commerce-order-paid" });
    expect(parsed.error).toContain("duplicate key");
  });

  it("serializes a thrown Error to its message", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logEmailLedgerInsertFailure({ source: "marketing-dispatch", templateSlug: "x", error: new Error("boom") });
    const parsed = JSON.parse((spy.mock.calls[0] as [string, string])[1]);
    expect(parsed.error).toBe("boom");
  });
});
