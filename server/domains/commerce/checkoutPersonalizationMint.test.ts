import { describe, expect, it, vi } from "vitest";
import type { VercelResponse } from "../../_lib/types/vercel.js";
import { applyCheckoutPersonalization } from "./checkoutPersonalizationMint.js";

describe("applyCheckoutPersonalization", () => {
  it("mints cookies and fires the precompute", async () => {
    const res = createResponse();
    const onNamesPersisted = vi.fn().mockResolvedValue(undefined);
    const mint = vi.fn(() => ["openlup_pid=t; HttpOnly", "openlup_pzn=1"]);

    await applyCheckoutPersonalization({
      res,
      clientId: "c-1",
      ownerName: "Anna",
      dogName: "Reksio",
      personalizationOnPersist: { onNamesPersisted },
      mintPersonalizationCookies: mint,
    });

    expect(mint).toHaveBeenCalledWith("c-1");
    expect(res.setHeader).toHaveBeenCalledWith("Set-Cookie", [
      "openlup_pid=t; HttpOnly",
      "openlup_pzn=1",
    ]);
    expect(onNamesPersisted).toHaveBeenCalledWith({
      clientId: "c-1",
      primaryPetId: null,
      ownerName: "Anna",
      dogName: "Reksio",
    });
  });

  it("appends to a Set-Cookie already staged on the response (never clobbers)", async () => {
    const res = createResponse();
    vi.mocked(res.getHeader).mockReturnValue(["existing=1"]);

    await applyCheckoutPersonalization({
      res,
      clientId: "c-1",
      ownerName: null,
      dogName: null,
      mintPersonalizationCookies: () => ["openlup_pid=t"],
    });

    expect(res.setHeader).toHaveBeenCalledWith("Set-Cookie", ["existing=1", "openlup_pid=t"]);
  });

  it("swallows a cookie-mint throw and still fires the precompute", async () => {
    const res = createResponse();
    const onNamesPersisted = vi.fn().mockResolvedValue(undefined);

    await applyCheckoutPersonalization({
      res,
      clientId: "c-1",
      ownerName: "Ola",
      dogName: null,
      personalizationOnPersist: { onNamesPersisted },
      mintPersonalizationCookies: () => {
        throw new Error("boom");
      },
    });

    expect(res.setHeader).not.toHaveBeenCalled();
    expect(onNamesPersisted).toHaveBeenCalledOnce();
  });

  it("swallows a precompute throw", async () => {
    const res = createResponse();
    await expect(
      applyCheckoutPersonalization({
        res,
        clientId: "c-1",
        ownerName: "Ola",
        dogName: null,
        personalizationOnPersist: {
          onNamesPersisted: vi.fn().mockRejectedValue(new Error("boom")),
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("no-ops when neither dep is provided", async () => {
    const res = createResponse();
    await applyCheckoutPersonalization({ res, clientId: "c-1", ownerName: null, dogName: null });
    expect(res.setHeader).not.toHaveBeenCalled();
  });
});

function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    getHeader: vi.fn().mockReturnValue(undefined),
  } as unknown as VercelResponse;
  return res;
}
