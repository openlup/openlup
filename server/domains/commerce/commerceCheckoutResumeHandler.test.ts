import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  CHECKOUT_RESUME_CONTRACT_VERSION,
  type CheckoutResumeDraft,
  type CheckoutResumeUpsertRequest,
} from "../../../src/domains/commerce/checkoutResumeContracts.js";
import type {
  CommerceCheckoutResumeDraftPort,
} from "../../../src/domains/commerce/ports.js";
import {
  createCommerceCheckoutResumeReadHandler,
  createCommerceCheckoutResumeUpsertHandler,
} from "./commerceCheckoutResumeHandler.js";
import type { CheckoutResumeTokenCodec } from "./checkoutResumeToken.js";

const TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO123";

describe("commerce checkout resume handlers", () => {
  it("upserts sanitized hidden resume state and returns the opaque token", async () => {
    const port = createPort();
    const res = createResponse();

    await createCommerceCheckoutResumeUpsertHandler({
      resumePort: port,
      tokenCodec: codec(),
      now: fixedNow,
    })(request("POST", upsertBody()), res);

    expect(port.upsertDraft).toHaveBeenCalledWith({
      tokenHash: "token-hash",
      idempotencyKeyHash: "idempotency-hash",
      lastSectionId: "product_selection",
      draftState: upsertBody().draftState,
      expiresAt: "2026-06-06T12:00:00.000Z",
      now: "2026-06-06T10:00:00.000Z",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: {
        contractVersion: CHECKOUT_RESUME_CONTRACT_VERSION,
        resumeToken: TOKEN,
        draft: draft(false),
      },
      meta: { contractVersion: CHECKOUT_RESUME_CONTRACT_VERSION },
    });
  });

  it("reads by URL token hash without echoing the token", async () => {
    const port = createPort();
    const res = createResponse();

    await createCommerceCheckoutResumeReadHandler({
      resumePort: port,
      tokenCodec: codec(),
      now: fixedNow,
    })(request("GET", undefined, { token: TOKEN }), res);

    expect(port.readDraftByTokenHash).toHaveBeenCalledWith({
      tokenHash: "token-hash",
      now: "2026-06-06T10:00:00.000Z",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    const payload = vi.mocked(res.json).mock.calls[0][0];
    expect(JSON.stringify(payload)).not.toContain(TOKEN);
    expect(payload).toEqual({
      ok: true,
      data: {
        contractVersion: CHECKOUT_RESUME_CONTRACT_VERSION,
        draft: draft(true),
      },
      meta: { contractVersion: CHECKOUT_RESUME_CONTRACT_VERSION },
    });
  });

  it("rejects invalid methods, invalid bodies and missing drafts", async () => {
    const method = createResponse();
    await createCommerceCheckoutResumeUpsertHandler({
      resumePort: createPort(),
      tokenCodec: codec(),
    })(request("GET"), method);

    const invalid = createResponse();
    await createCommerceCheckoutResumeUpsertHandler({
      resumePort: createPort(),
      tokenCodec: codec(),
    })(request("POST", { draftState: { email: "ada@example.com" } }), invalid);

    const missing = createResponse();
    await createCommerceCheckoutResumeReadHandler({
      resumePort: createPort({ missing: true }),
      tokenCodec: codec(),
    })(request("GET", undefined, { token: TOKEN }), missing);

    expect(method.status).toHaveBeenCalledWith(405);
    expect(invalid.status).toHaveBeenCalledWith(400);
    expect(missing.status).toHaveBeenCalledWith(404);
  });
});

function request(
  method: string,
  body?: unknown,
  query: Record<string, string> = {},
): VercelRequest {
  return { method, body, query } as unknown as VercelRequest;
}

function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;

  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function createPort(options: { missing?: boolean } = {}): CommerceCheckoutResumeDraftPort {
  return {
    upsertDraft: vi.fn().mockResolvedValue(draft(false)),
    readDraftByTokenHash: vi.fn().mockResolvedValue(options.missing ? null : draft(true)),
  };
}

function codec(): CheckoutResumeTokenCodec {
  return {
    generateToken: vi.fn().mockReturnValue(TOKEN),
    hashToken: vi.fn().mockReturnValue("token-hash"),
    hashIdempotencyKey: vi.fn().mockReturnValue("idempotency-hash"),
  };
}

function fixedNow(): Date {
  return new Date("2026-06-06T10:00:00.000Z");
}

function upsertBody(): CheckoutResumeUpsertRequest {
  return {
    idempotencyKey: "resume-2026-06-06",
    lastSectionId: "product_selection",
    ttlMinutes: 120,
    draftState: {
      version: CHECKOUT_RESUME_CONTRACT_VERSION,
      mode: "one_time",
      cadenceDays: null,
      cart: {
        items: [
          {
            sku: "OPENLUP-DOG-LAMB-CAN-400G",
            productSlug: "lamb",
            variantId: "variant_lamb_400g",
            quantity: 4,
          },
        ],
      },
      completion: {
        petProfile: true,
        productSelection: true,
        cadence: false,
        account: false,
        shipping: false,
        billing: false,
        payment: false,
        review: false,
      },
      redactedFields: ["contact", "shipping_address"],
    },
  };
}

function draft(replayed: boolean): CheckoutResumeDraft {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    contractVersion: CHECKOUT_RESUME_CONTRACT_VERSION,
    lastSectionId: "product_selection",
    draftState: upsertBody().draftState,
    expiresAt: "2026-06-06T12:00:00.000Z",
    createdAt: "2026-06-06T10:00:00.000Z",
    updatedAt: "2026-06-06T10:00:00.000Z",
    replayed,
  };
}
