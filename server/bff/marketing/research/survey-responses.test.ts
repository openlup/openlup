import { describe, expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "../../../_lib/types/http.js";

const unitComposition = vi.hoisted(() => ({ enabled: true }));
vi.mock("#deployment-route-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#deployment-route-policy")>();
  return {
    ...actual,
    enforceDeploymentRoutePolicy: (...args: Parameters<typeof actual.enforceDeploymentRoutePolicy>) =>
      unitComposition.enabled || actual.enforceDeploymentRoutePolicy(...args),
  };
});

const { handleSubmit } = vi.hoisted(() => ({ handleSubmit: vi.fn() }));
vi.mock("./acquisitionEvidenceDirect.js", () => ({
  isDirectAcquisitionEvidenceBundle: () => true,
  isAcquisitionSurveyView: () => true,
  handleAcquisitionSurveySubmit: handleSubmit,
}));
import handler from "./survey-responses.js";

describe("marketing research survey responses public BFF route", () => {
  it("executes the direct survey path through the observed wrapper", async () => {
    handleSubmit.mockImplementation(async (_req: unknown, res: HttpResponse) => {
      res.status(200).json({ ok: true });
    });
    const res = response();
    await handler({ method: "POST", headers: {}, query: {}, body: {} } as unknown as HttpRequest, res);
    expect(handleSubmit).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(200);
  });
  it("public default refuses before invoking survey submission", async () => {
    unitComposition.enabled = false;
    handleSubmit.mockClear();
    try {
      const res = response();
      await handler({ method: "POST", headers: {}, query: {}, body: {} } as unknown as HttpRequest, res);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        ok: false, error: expect.objectContaining({ details: expect.objectContaining({ reason: "adopter_policy_required" }) }),
      }));
      expect(handleSubmit).not.toHaveBeenCalled();
    } finally {
      unitComposition.enabled = true;
    }
  });

});

function response(): HttpResponse {
  const res = { statusCode: 200, setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as HttpResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
