import { describe, expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "../../../../_lib/types/http.js";

const { handleList } = vi.hoisted(() => ({ handleList: vi.fn() }));
vi.mock("../../../marketing/research/acquisitionEvidenceDirect.js", () => ({
  isDirectAcquisitionEvidenceBundle: () => true,
  handleAcquisitionSurveyList: handleList,
}));
import handler from "./survey-responses.js";

describe("marketing research survey responses admin BFF route", () => {
  it("executes the direct operator read through the observed wrapper", async () => {
    handleList.mockImplementation(async (_req: unknown, res: HttpResponse) => {
      res.status(200).json({ ok: true });
    });
    const res = response();
    await handler({ method: "GET", headers: {}, query: { view: "acquisition_survey_v1" } } as unknown as HttpRequest, res);
    expect(handleList).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

function response(): HttpResponse {
  const res = { statusCode: 200, setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as HttpResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
