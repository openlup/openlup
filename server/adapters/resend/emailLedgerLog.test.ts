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

  it("redacts bearer tokens, provider keys, webhook secrets, and email addresses", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logEmailLedgerInsertFailure({
      source: "outbox-dispatch",
      templateSlug: "order-paid",
      error: new Error("Failed with Bearer secret_abc.123 key re_live_123456 whsec_dGVzdA== for customer@example.invalid"),
    });
    const parsedErr = JSON.parse((spy.mock.calls[0] as [string, string])[1]);
    expect(parsedErr.error).toBe("Failed with Bearer [redacted] key [redacted] [redacted] for [email]");
    expect(parsedErr.error).not.toContain("secret_abc");
    expect(parsedErr.error).not.toContain("re_live_123456");
    expect(parsedErr.error).not.toContain("whsec_dGVzdA");
    expect(parsedErr.error).not.toContain("customer@example.invalid");

    logEmailLedgerInsertFailure({
      source: "outbox-dispatch",
      templateSlug: "order-paid",
      error: { message: "dup for alice@example.invalid", token: "re_test_987654" },
    });
    const parsedObj = JSON.parse((spy.mock.calls[1] as [string, string])[1]);
    expect(parsedObj.error).toContain("[email]");
    expect(parsedObj.error).toContain("[redacted]");
    expect(parsedObj.error).not.toContain("alice@example.invalid");
    expect(parsedObj.error).not.toContain("re_test_987654");
  });
});
