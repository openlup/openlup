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

  it("enforces max document count, total byte cap, and max page cap", async () => {
    const tooManyDocs = mergeFixture({ maxDocuments: 2 });
    const tooManyDocsRes = await tooManyDocs.action(request(["t-1", "t-2", "t-3"]));
    expect(tooManyDocsRes.status).toBe(400);
    await expect(tooManyDocsRes.json()).resolves.toEqual({
      error: expect.stringContaining("maks. 2"),
    });
    expect(tooManyDocs.download).not.toHaveBeenCalled();

    const tooLargeInput = mergeFixture({ maxTotalBytes: 2 });
    const tooLargeInputRes = await tooLargeInput.action(request(["tester-1"]));
    expect(tooLargeInputRes.status).toBe(413);
    await expect(tooLargeInputRes.json()).resolves.toEqual({
      error: expect.stringContaining("2 B"),
    });

    const tooLargeSaved = mergeFixture({ maxTotalBytes: 10, savedBytes: new Uint8Array(12) });
    const tooLargeSavedRes = await tooLargeSaved.action(request(["tester-1"]));
    expect(tooLargeSavedRes.status).toBe(413);

    const tooManyPages = mergeFixture({ maxTotalPages: 1 });
    const tooManyPagesRes = await tooManyPages.action(request(["tester-1"]));
    expect(tooManyPagesRes.status).toBe(400);
    await expect(tooManyPagesRes.json()).resolves.toEqual({
      error: expect.stringContaining("maks. 1"),
    });
  });

  it("encodes merged PDF bytes with Buffer base64 by default and redacts errors", async () => {
    const fixture = mergeFixture({ useDefaultBase64: true, savedBytes: new Uint8Array([80, 68, 70]) });
    await expect(fixture.action(request(["tester-1"])).then((response) => response.json())).resolves.toMatchObject({
      success: true,
      pdf_base64: Buffer.from([80, 68, 70]).toString("base64"),
      label_count: 2,
    });

    const loadFail = mergeFixture({ loadError: new Error("corrupt pdf password=pw123 user@example.com") });
    const loadFailBody = await loadFail.action(request(["tester-1"])).then((response) => response.json());
    expect(loadFailBody.errors[0]).toBe("Good Label: Error: corrupt pdf password: [redacted] [redacted-email]");
    expect(loadFailBody.errors[0]).not.toContain("pw123");

    const outerFail = createMergeLabelDocumentsAction({
      createClient: () => { throw new Error("boom Bearer secret_tok user@example.com"); },
      createPdf: vi.fn(),
      loadPdf: vi.fn(),
    });
    const outerBody = await outerFail(request(["tester-1"])).then((response) => response.json());
    expect(outerBody.error).toBe("Error: boom Bearer [redacted] [redacted-email]");
  });
});

function mergeFixture(input: {
  onlyMissing?: boolean;
  legacyUrl?: boolean;
  legacyStorageUrl?: boolean;
  maxDocuments?: number;
  maxTotalBytes?: number;
  maxTotalPages?: number;
  savedBytes?: Uint8Array;
  useDefaultBase64?: boolean;
  loadError?: Error;
} = {}) {
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
    save: vi.fn().mockResolvedValue(input.savedBytes ?? new Uint8Array([1, 2, 3])),
  };
  const client = {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "admin-1" } }, error: null }) },
    from: (table: string) => table === "admin_users"
      ? { select: () => ({ eq: () => ({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: "admin-1" } }) }) }) }
      : { select: () => ({ in: () => ({ not: vi.fn().mockResolvedValue({ data: testers, error: null }) }) }) },
    storage: { from: storageFrom },
  } as unknown as CarrierLabelClient;
  const loadPdf = input.loadError
    ? vi.fn().mockRejectedValue(input.loadError)
    : vi.fn().mockResolvedValue({ getPageIndices: () => [0] });
  return {
    action: createMergeLabelDocumentsAction({
      createClient: () => client,
      createPdf: vi.fn().mockResolvedValue(merged),
      loadPdf,
      ...(input.useDefaultBase64 ? {} : { encodeBase64: () => "MERGED" }),
      maxDocuments: input.maxDocuments,
      maxTotalBytes: input.maxTotalBytes,
      maxTotalPages: input.maxTotalPages,
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
