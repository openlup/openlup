import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPartnerInquiryIdempotencyKey,
  submitPublicB2BInquiry,
} from "./publicB2BInquiryClient";

describe("submitPublicB2BInquiry", () => {
  it("posts public B2B inquiries through the typed BFF client", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          data: { success: true, id: "inq-1" },
        }),
    });

    await expect(submitPublicB2BInquiry({
      company: "Acme Pet Foods",
      country: "US",
      firstName: "Jane",
      lastName: "Smith",
      email: "jane@acmepets.com",
      phone: "+1 555 123 4567",
      notes: "Private label wet dog food for retail.",
    }, { fetcher, headers: { "Idempotency-Key": "partner-command-0001" } })).resolves.toEqual({ success: true, id: "inq-1" });

    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/bff/partners/b2b-inquiries");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("idempotency-key")).toBe("partner-command-0001");
    expect(JSON.parse(String(init.body))).toEqual({
      company: "Acme Pet Foods",
      country: "US",
      firstName: "Jane",
      lastName: "Smith",
      email: "jane@acmepets.com",
      phone: "+1 555 123 4567",
      notes: "Private label wet dog food for retail.",
    });
  });

  it("creates a bounded partner command key", () => {
    expect(createPartnerInquiryIdempotencyKey()).toMatch(/^partner-[0-9a-f-]{36}$/);
  });
});

describe("createPartnerInquiryIdempotencyKey", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mints from crypto.randomUUID when the browser exposes it", () => {
    const randomUUID = vi.fn(() => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    vi.stubGlobal("crypto", { randomUUID });

    expect(createPartnerInquiryIdempotencyKey()).toBe(
      "partner-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    );
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  // The key is minted during PrivateLabelForm's render, so a browser without
  // crypto.randomUUID must still get a key instead of a thrown blank route.
  it("falls back to a distinct prefixed key when crypto.randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {});

    expect(() => createPartnerInquiryIdempotencyKey()).not.toThrow();

    const key = createPartnerInquiryIdempotencyKey();
    expect(key).toMatch(/^partner-\d+-[0-9a-z]+$/);
    expect(key).not.toBe(createPartnerInquiryIdempotencyKey());
  });

  it("falls back when crypto itself is absent", () => {
    vi.stubGlobal("crypto", undefined);

    expect(createPartnerInquiryIdempotencyKey()).toMatch(/^partner-\d+-[0-9a-z]+$/);
  });
});
