import { describe, expect, it, vi } from "vitest";
import {
  CARRIER_DISPLAY_NAME,
  CARRIER_NAMESPACE,
  CARRIER_PROVIDER_ID,
  CARRIER_SOAP_TIMEOUT_MS,
  CarrierSoapResponseTooLargeError,
  buildBookCourierEnvelope,
  callCarrierSoap,
  extractCarrierPickupOrderId,
  parseStreet,
  sanitizeCarrierError,
} from "./adminDhlSoap.js";

describe("admin carrier SOAP", () => {
  it("pins the visible provider identity used by external contracts", () => {
    expect({ display: CARRIER_DISPLAY_NAME, id: CARRIER_PROVIDER_ID })
      .toEqual({ display: "DHL", id: "dhl" });
  });

  it("escapes courier payload and extracts a namespaced provider order", () => {
    const envelope = buildBookCourierEnvelope({ auth: { username: "u", password: "p" }, pickupDate: "2026-08-17", pickupTimeFrom: "10:00", pickupTimeTo: "12:00", contactPerson: "Ada", contactPhone: "123", additionalInfo: "A & B", shipmentIds: ["SHIP-1"] });
    expect(envelope).toContain("A &amp; B");
    expect(envelope).toContain("<shipmentIdList>");
    expect(extractCarrierPickupOrderId("<x:bookCourierResult xmlns:x=\"d\"><x:item>A</x:item><x:item>B</x:item></x:bookCourierResult>")).toBe("A, B");
  });

  it("keeps address parsing and provider sanitization deterministic", () => {
    expect(parseStreet("Długa 12 / 4")).toEqual({ street: "Długa", houseNumber: "12/4" });
    expect(sanitizeCarrierError("password=secret <b>failure</b>")).toBe("password: [redacted] failure");
  });

  it("uses the exact provider SOAPAction with manual redirect and an AbortSignal", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "<ok/>" });
    await callCarrierSoap(fetchImpl, "bookCourier", "<xml/>");
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      redirect: "manual",
      signal: expect.any(AbortSignal),
      headers: { SOAPAction: `${CARRIER_NAMESPACE}#bookCourier`, "Content-Type": "text/xml; charset=utf-8" },
    }));
  });

  it("enforces the default 15s timeout across a stalled fetch", async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      const fetchImpl = vi.fn((_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        observedSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      });

      const pending = callCarrierSoap(fetchImpl as never, "bookCourier", "<xml/>");
      const assertion = expect(pending).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(CARRIER_SOAP_TIMEOUT_MS);
      await assertion;
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the timeout active across streaming response body reads and cancels the reader", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<partial>"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));

    await expect(
      callCarrierSoap(fetchImpl as never, "getLabels", "<xml/>", { timeoutMs: 30 }),
    ).rejects.toThrow(/timed out/i);
    expect(cancelled).toBe(true);
  });

  it("propagates caller AbortSignal both before and during the request", async () => {
    const preAborted = new AbortController();
    preAborted.abort(new Error("caller cancelled"));
    const neverCalled = vi.fn();
    await expect(
      callCarrierSoap(neverCalled as never, "bookCourier", "<xml/>", { signal: preAborted.signal }),
    ).rejects.toThrow("caller cancelled");
    expect(neverCalled).not.toHaveBeenCalled();

    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });

    const pending = callCarrierSoap(fetchImpl as never, "bookCourier", "<xml/>", {
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    controller.abort(new Error("worker shutdown"));
    await expect(pending).rejects.toThrow("worker shutdown");
    expect(observedSignal?.aborted).toBe(true);
  });

  it("caps streamed, declared, and stubbed response bodies at maxBodyBytes", async () => {
    let cancelled = false;
    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64));
        controller.enqueue(new Uint8Array(64));
      },
      cancel() {
        cancelled = true;
      },
    });
    const streamFetch = vi.fn().mockResolvedValue(new Response(oversizedStream, { status: 200 }));
    await expect(
      callCarrierSoap(streamFetch as never, "getLabels", "<xml/>", { maxBodyBytes: 100 }),
    ).rejects.toBeInstanceOf(CarrierSoapResponseTooLargeError);
    expect(cancelled).toBe(true);

    const declaredFetch = vi.fn().mockResolvedValue(
      new Response("small", { status: 200, headers: { "content-length": "2048" } }),
    );
    await expect(
      callCarrierSoap(declaredFetch as never, "getLabels", "<xml/>", { maxBodyBytes: 100 }),
    ).rejects.toBeInstanceOf(CarrierSoapResponseTooLargeError);

    const stubFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "x".repeat(120) });
    await expect(
      callCarrierSoap(stubFetch as never, "getLabels", "<xml/>", { maxBodyBytes: 100 }),
    ).rejects.toBeInstanceOf(CarrierSoapResponseTooLargeError);
  });
});
