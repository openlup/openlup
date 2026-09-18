import { describe, expect, it, vi } from "vitest";
import { CommerceOmsConflictError } from "../../../src/domains/commerce/omsPorts.js";
import { createAdminCommerceOrderMarkRefundedHandler } from "./commerceOmsMarkRefundedHandler.js";
import {
  authorize,
  markRefundedRequest,
  markRefundedResponse,
  request,
  response,
} from "./commerceOmsHandlersTestKit.js";

describe("admin commerce OMS mark-refunded handler", () => {
  it("keeps refund mutations disabled by default", async () => {
    const res = response();
    const port = { markRefunded: vi.fn() };

    await createAdminCommerceOrderMarkRefundedHandler({
      omsPort: port,
      authorizeAdmin: authorize(),
      mutationsEnabled: () => false,
    })(request("POST", markRefundedRequest()), res);

    expect(port.markRefunded).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("maps mark-refunded conflicts to BFF CONFLICT when mutations are explicitly enabled", async () => {
    const res = response();
    await createAdminCommerceOrderMarkRefundedHandler({
      omsPort: {
        markRefunded: vi.fn().mockRejectedValue(new CommerceOmsConflictError("Commerce OMS hold conflict")),
      },
      authorizeAdmin: authorize(),
      mutationsEnabled: () => true,
    })(request("POST", markRefundedRequest()), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "CONFLICT" }),
      }),
    );
  });

  it("returns enabled mark-refunded mutation responses", async () => {
    const res = response();
    const mutationResult = markRefundedResponse();
    const port = { markRefunded: vi.fn().mockResolvedValue(mutationResult) };

    await createAdminCommerceOrderMarkRefundedHandler({
      omsPort: port,
      authorizeAdmin: authorize(),
      mutationsEnabled: () => true,
    })(request("POST", markRefundedRequest()), res);

    expect(port.markRefunded).toHaveBeenCalledWith({
      ...markRefundedRequest(),
      actorUserId: "admin-user-1",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: mutationResult });
  });
});
