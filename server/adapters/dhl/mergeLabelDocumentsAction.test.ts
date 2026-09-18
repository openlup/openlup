import { describe, expect, it, vi } from "vitest";
import { createMergeLabelDocumentsAction, type CarrierLabelClient } from "./mergeLabelDocumentsAction.js";

describe("merge label documents action", () => {
  it("keeps OPTIONS and missing authorization side-effect free", async () => {
    const createClient = vi.fn((): CarrierLabelClient => { throw new Error("client must stay lazy"); });
    const action = createMergeLabelDocumentsAction({
      createClient, createPdf: vi.fn(), loadPdf: vi.fn(),
    });
    await expect(action(new Request("https://example.test", { method: "OPTIONS" })).then((response) => response.text()))
      .resolves.toBe("ok");
    await expect(action(new Request("https://example.test")).then((response) => response.json()))
      .resolves.toEqual({ error: "Unauthorized" });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("merges cached private label object keys without network egress", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network egress forbidden"));
    const fixture = mergeFixture();
    // The DB result order remains authoritative; it is not reordered to the request IDs.
    await expect(fixture.action(request(["tester-2", "tester-1"])).then((response) => response.json())).resolves.toEqual({
      success: true,
      pdf_base64: "MERGED",
      label_count: 2,
      errors: ["Bad Label: Historical DHL label is unavailable in storage"],
    });
    expect(fixture.storageFrom).toHaveBeenCalledWith("dhl-labels");
    expect(fixture.download).toHaveBeenNthCalledWith(1, "tester-1/one.pdf");
    expect(fixture.download).toHaveBeenNthCalledWith(2, "tester-2/missing.pdf");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the no-merged-pages failure contract", async () => {
    const fixture = mergeFixture({ onlyMissing: true });
    const response = await fixture.action(request(["tester-2"]));
    await expect(response.json()).resolves.toEqual({
      error: "Nie udało się zmergować żadnej etykiety",
      errors: ["Bad Label: Historical DHL label is unavailable in storage"],
    });
  });

  it("refuses legacy label URLs without invoking storage or network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network egress forbidden"));
    const fixture = mergeFixture({ legacyUrl: true });
    const response = await fixture.action(request(["tester-1"]));

    await expect(response.json()).resolves.toEqual({
      error: "Nie udało się zmergować żadnej etykiety",
      errors: ["Good Label: Historical DHL label is not cached"],
    });
    expect(fixture.storageFrom).toHaveBeenCalledWith("dhl-labels");
    expect(fixture.download).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps a legacy private-bucket URL back to its object key without fetching the URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("raw URL fetch forbidden"));
    const fixture = mergeFixture({ legacyStorageUrl: true });

    await expect(fixture.action(request(["tester-1"])).then((response) => response.json())).resolves.toEqual({
      success: true,
      pdf_base64: "MERGED",
      label_count: 2,
    });
    expect(fixture.download).toHaveBeenCalledWith("tester-1/one.pdf");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

function mergeFixture(input: { onlyMissing?: boolean; legacyUrl?: boolean; legacyStorageUrl?: boolean } = {}) {
  const testers = input.onlyMissing
    ? [{ id: "tester-2", first_name: "Bad", last_name: "Label", tracking_number: null, label_url: "tester-2/missing.pdf" }]
    : input.legacyUrl
    ? [{ id: "tester-1", first_name: "Good", last_name: "Label", tracking_number: null, label_url: "https://legacy.example/label.pdf" }]
    : input.legacyStorageUrl
    ? [{ id: "tester-1", first_name: "Good", last_name: "Label", tracking_number: null, label_url: "https://project.supabase.co/storage/v1/object/sign/dhl-labels/tester-1%2Fone.pdf?token=expired" }]
    : [
      { id: "tester-1", first_name: "Good", last_name: "Label", tracking_number: null, label_url: "tester-1/one.pdf" },
      { id: "tester-2", first_name: "Bad", last_name: "Label", tracking_number: null, label_url: "tester-2/missing.pdf" },
    ];
  const download = vi.fn(async (path: string) => path.includes("missing")
    ? { data: null, error: { message: "not found" } }
    : { data: new Blob([new Uint8Array([80, 68, 70])]), error: null });
  const storageFrom = vi.fn(() => ({ download }));
  const pages: unknown[] = [];
  const merged = {
    copyPages: vi.fn().mockResolvedValue(["page-1", "page-2"]),
    addPage: vi.fn((page: unknown) => pages.push(page)),
    getPageCount: vi.fn(() => pages.length),
    save: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  };
  const client = {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "admin-1" } }, error: null }) },
    from: (table: string) => table === "admin_users"
      ? { select: () => ({ eq: () => ({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: "admin-1" } }) }) }) }
      : { select: () => ({ in: () => ({ not: vi.fn().mockResolvedValue({ data: testers, error: null }) }) }) },
    storage: { from: storageFrom },
  } as unknown as CarrierLabelClient;
  return {
    action: createMergeLabelDocumentsAction({
      createClient: () => client,
      createPdf: vi.fn().mockResolvedValue(merged),
      loadPdf: vi.fn().mockResolvedValue({ getPageIndices: () => [0] }),
      encodeBase64: () => "MERGED",
    }),
    download,
    storageFrom,
  };
}

function request(testerIds: string[]): Request {
  return new Request("https://example.test", {
    method: "POST",
    headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify({ tester_ids: testerIds }),
  });
}
