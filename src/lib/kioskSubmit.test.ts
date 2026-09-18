/** @vitest-environment jsdom -- exercises browser-path behavior (window/storage/DOM). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

async function loadSubmitter() {
  vi.resetModules();
  return import("@/lib/kioskSubmit");
}

describe("submitSurveyResponse", () => {
  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores a submitted response and marks it synced when the BFF accepts it", async () => {
    fetchMock.mockResolvedValue(bffResponse(true));
    const { submitSurveyResponse } = await loadSubmitter();

    await expect(submitSurveyResponse("producer", { screen1_role: "Founder" })).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/bff/marketing/research/survey-responses",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(localStorage.getItem("producer_survey_responses") ?? "[]")).toEqual([
      { screen1_role: "Founder", _syncStatus: "synced" },
    ]);
  });

  it("keeps failed submissions pending and retries them in the background", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(bffResponse(false))
      .mockResolvedValueOnce(bffResponse(true));
    const { submitSurveyResponse } = await loadSubmitter();

    await expect(submitSurveyResponse("consumer", { screen1_pet_type: "Dog" })).resolves.toEqual({ ok: false });
    expect(JSON.parse(localStorage.getItem("consumer_survey_responses") ?? "[]")).toEqual([
      expect.objectContaining({
        screen1_pet_type: "Dog",
        _syncStatus: "pending",
        _retryAttempt: 1,
      }),
    ]);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(localStorage.getItem("consumer_survey_responses") ?? "[]")).toEqual([
      expect.objectContaining({ screen1_pet_type: "Dog", _syncStatus: "synced" }),
    ]);
  });

  it("abandons stale retry entries instead of retrying forever", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T08:00:00.000Z"));
    fetchMock.mockResolvedValue(bffResponse(false));
    localStorage.setItem("producer_survey_responses", JSON.stringify([
      {
        screen1_role: "Founder",
        _syncStatus: "pending",
        _queuedAt: Date.now() - 25 * 60 * 60_000,
        _retryAttempt: 2,
        _retryNextAt: Date.now() - 1_000,
      },
    ]));
    const { submitSurveyResponse } = await loadSubmitter();

    await submitSurveyResponse("producer", { screen1_role: "Operator" });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, init]) => {
      const body = JSON.parse(String((init as RequestInit).body));
      return body.responseData.screen1_role;
    })).toEqual(["Operator", "Operator"]);
    expect(JSON.parse(localStorage.getItem("producer_survey_responses") ?? "[]")[0]).toMatchObject({
      screen1_role: "Founder",
      _syncStatus: "abandoned",
    });
  });
});

function bffResponse(ok: boolean) {
  return {
    status: 200,
    json: async () => ({
      ok: true,
      data: { ok, ...(ok ? { id: "survey-1" } : {}) },
    }),
  };
}