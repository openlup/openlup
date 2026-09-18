import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  createCarrierLabelPort,
  createCarrierMergePort,
  mapLegacyLabelResponse,
  mapLegacyMergeResponse,
} from "./labelsAdapter.js";

const SERVICE_ENV = { SUPABASE_URL: "https://example.supabase.co" };

describe("label adapter", () => {
  it("uses native label actions instead of dynamically importing hosted handlers", async () => {
    const source = await readFile(new URL("./labelsAdapter.ts", import.meta.url), "utf8");
    expect(source).toContain("createCarrierLabelAction");
    expect(source).toContain("createMergeLabelDocumentsAction");
    expect(source).not.toContain("createCarrierLabelOperation");
    expect(source).not.toContain("dhl_credentials_not_configured");
    expect(source).not.toContain("get-dhl-label/handler.ts");
    expect(source).not.toContain("merge-dhl-labels/handler.ts");
  });

  it("maps legacy label fields to the typed fulfillment contract", () => {
    expect(mapLegacyLabelResponse({ label_url: "https://cdn.example/TRK-1.pdf" }))
      .toEqual({ labelUrl: "https://cdn.example/TRK-1.pdf" });
  });

  it("maps missing label fields to an empty label URL", () => {
    expect(mapLegacyLabelResponse({})).toEqual({ labelUrl: "" });
  });

  it("runs the local label handler runner with the existing tester contract", async () => {
    const runLabel = vi.fn().mockResolvedValue({
      status: 200,
      body: { label_url: "https://cdn.example/TRK-2.pdf" },
    });
    const port = createCarrierLabelPort({
      accessToken: "admin-token",
      env: SERVICE_ENV,
      runLabel,
    });

    await expect(readLabel(port, "tester-1")).resolves.toEqual({
      labelUrl: "https://cdn.example/TRK-2.pdf",
    });

    expect(runLabel).toHaveBeenCalledWith(
      { accessToken: "admin-token", testerId: "tester-1" },
      SERVICE_ENV,
    );
  });

  it("throws label runner and legacy errors", async () => {
    const upstream = createCarrierLabelPort(
      {
        accessToken: "admin-token",
        runLabel: vi.fn().mockResolvedValue({ status: 502, body: { error: "handler down" } }),
      },
    );
    await expect(readLabel(upstream, "tester-1")).rejects.toThrow("handler down");

    const legacy = createCarrierLabelPort(
      {
        accessToken: "admin-token",
        runLabel: vi.fn().mockResolvedValue({ status: 200, body: { error: "label rejected" } }),
      },
    );
    await expect(readLabel(legacy, "tester-1")).rejects.toThrow("label rejected");
  });
});

describe("merge labels adapter", () => {
  it("maps legacy merge labels response into the BFF contract", () => {
    expect(mapLegacyMergeResponse({ pdf_base64: "PDFDATA", label_count: 2 }))
      .toEqual({ pdfBase64: "PDFDATA", labelCount: 2 });
  });

  it("maps missing merge label fields to empty defaults", () => {
    expect(mapLegacyMergeResponse({})).toEqual({ pdfBase64: "", labelCount: 0 });
  });

  it("runs the local merge labels handler runner with the existing tester contract", async () => {
    const runMergeLabels = vi.fn().mockResolvedValue({
      status: 200,
      body: { pdf_base64: "PDFDATA", label_count: 2 },
    });
    const port = createCarrierMergePort({
      accessToken: "admin-token",
      env: SERVICE_ENV,
      runMergeLabels,
    });

    await expect(mergeLabels(port, ["tester-1", "tester-2"])).resolves.toEqual({
      pdfBase64: "PDFDATA",
      labelCount: 2,
    });

    expect(runMergeLabels).toHaveBeenCalledWith(
      { accessToken: "admin-token", testerIds: ["tester-1", "tester-2"] },
      SERVICE_ENV,
    );
  });

  it("throws merge upstream and legacy errors", async () => {
    const upstream = createCarrierMergePort({
      accessToken: "admin-token",
      runMergeLabels: vi.fn().mockResolvedValue({ status: 502, body: { error: "handler down" } }),
    });
    await expect(mergeLabels(upstream, ["tester-1"])).rejects.toThrow("handler down");

    const legacy = createCarrierMergePort({
      accessToken: "admin-token",
      runMergeLabels: vi.fn().mockResolvedValue({ status: 200, body: { error: "merge rejected" } }),
    });
    await expect(mergeLabels(legacy, ["tester-1"])).rejects.toThrow("merge rejected");
  });

  it("keeps unrelated port methods unavailable on label route adapters", async () => {
    const labelPort = createCarrierLabelPort({ accessToken: "admin-token", runLabel: vi.fn() });
    const mergePort = createCarrierMergePort({ accessToken: "admin-token", runMergeLabels: vi.fn() });

    await expect(mergeLabels(labelPort, ["tester-1"])).rejects.toThrow(
      "Use dhl-merge-labels route",
    );
    await expect(readLabel(mergePort, "tester-1")).rejects.toThrow(
      "Use dhl-label route",
    );
  });
});

function readLabel(port: ReturnType<typeof createCarrierLabelPort>, testerId: string) {
  return port.getDhlLabel({ testerId });
}

function mergeLabels(port: ReturnType<typeof createCarrierMergePort>, testerIds: string[]) {
  return port.mergeDhlLabels({ testerIds });
}
