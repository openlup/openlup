import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  clearDhlShipmentStateUpdate as clearShipmentStateUpdate,
  createDhlCleanupPort as createCleanupPort,
  createDhlClearShipmentStatePort as createStatePort,
  mapLegacyCleanupDhlResponse as mapLegacyResponse,
  runCleanup,
} from "./cleanupAdapter.js";

describe("cleanup adapter", () => {
  it("maps legacy cleanup response into the BFF contract", () => {
    expect(
      mapLegacyResponse(legacyBody({ providerDeleted: true, labelDeleted: true, canProceed: false })),
    ).toEqual(portBody({ providerDeleted: true, labelDeleted: true }));
  });

  it("maps missing cleanup fields to safe defaults", () => {
    expect(mapLegacyResponse({})).toEqual(portBody());
  });

  it("runs the local cleanup handler runner with the existing tracking number contract", async () => {
    const runCleanup = vi.fn().mockResolvedValue({
      status: 200,
      body: legacyBody({ providerDeleted: true, labelDeleted: true }),
    });
    const port = createCleanupPort({
      accessToken: "admin-token",
      env: { SUPABASE_URL: "https://example.supabase.co" },
      runCleanup,
    });

    await expect(port.cleanupDhlShipment({ trackingNumber: "TRK-1" })).resolves.toEqual(
      portBody({ providerDeleted: true, labelDeleted: true }),
    );

    expect(runCleanup).toHaveBeenCalledWith(
      { accessToken: "admin-token", trackingNumber: "TRK-1" },
      { SUPABASE_URL: "https://example.supabase.co" },
    );
  });

  it("uses the Node cleanup action instead of dynamically importing the Edge handler", async () => {
    const source = await readFile(new URL("./cleanupAdapter.ts", import.meta.url), "utf8");
    expect(source).toContain("createCleanupAction");
    expect(source).not.toContain("cleanup-dhl-shipment/handler.ts");
    expect(source.indexOf("if (!url || !serviceRoleKey)")).toBeLessThan(source.indexOf("const action = createCleanupAction"));
    expect(source.indexOf("dhl_credentials_not_configured")).toBeLessThan(source.indexOf("const action = createCleanupAction"));
  });

  it("returns the existing configuration errors before provider effects", async () => {
    const fetchImpl = vi.fn();
    await expect(runCleanup({ accessToken: "admin-token", trackingNumber: "TRK-1" }, {}, fetchImpl))
      .resolves.toEqual({ status: 500, body: { error: "supabase_service_role_not_configured" } });
    await expect(runCleanup({ accessToken: "admin-token", trackingNumber: "TRK-1" }, {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    }, fetchImpl)).resolves.toEqual({
      status: 500,
      body: { error: "dhl_credentials_not_configured" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws cleanup runner and legacy errors", async () => {
    const upstream = createCleanupPort(
      {
        accessToken: "admin-token",
        runCleanup: vi.fn().mockResolvedValue({ status: 502, body: { error: "handler down" } }),
      },
    );
    await expect(upstream.cleanupDhlShipment({ trackingNumber: "TRK-1" })).rejects.toThrow("handler down");

    const legacy = createCleanupPort(
      {
        accessToken: "admin-token",
        runCleanup: vi.fn().mockResolvedValue({ status: 200, body: { error: { code: "DHL" } } }),
      },
    );
    await expect(legacy.cleanupDhlShipment({ trackingNumber: "TRK-1" })).rejects.toThrow(
      "{\"code\":\"DHL\"}",
    );
  });
});

describe("clear shipment state infrastructure adapter", () => {
  it("maps clear shipment state into the legacy tester update fields", () => {
    expect(clearShipmentStateUpdate()).toEqual({
      tracking_number: null,
      tracking_url: null,
      dhl_shipment_id: null,
      dhl_shipment_date: null,
      label_url: null,
    });
  });

  it("clears legacy tester fields through the existing testers update", async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ update });
    const port = createStatePort({ from } as never);

    await expect(port.clearDhlShipmentState({ testerId: "tester-1" })).resolves.toEqual({
      testerId: "tester-1",
      cleared: true,
    });

    expect(from).toHaveBeenCalledWith("testers");
    expect(update).toHaveBeenCalledWith(clearShipmentStateUpdate());
    expect(eq).toHaveBeenCalledWith("id", "tester-1");
  });

  it("throws clear-state update errors", async () => {
    const eq = vi.fn().mockResolvedValue({ error: new Error("db down") });
    const update = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ update });
    const port = createStatePort({ from } as never);

    await expect(port.clearDhlShipmentState({ testerId: "tester-1" })).rejects.toThrow("db down");
  });

  it("rejects unrelated shipment port methods instead of calling another provider surface", async () => {
    const port = createStatePort({ from: vi.fn() } as never);

    await expect(
      port.createDhlShipment({ testerId: "tester-1", skipStatusChange: false }),
    ).rejects.toThrow("Use dhl-create-shipment route");
    await expect(port.getDhlLabel({ testerId: "tester-1" })).rejects.toThrow("Use dhl-label route");
    await expect(port.mergeDhlLabels({ testerIds: ["tester-1"] })).rejects.toThrow(
      "Use dhl-merge-labels route",
    );
    await expect(
      port.bookDhlCourier({
        testerIds: ["tester-1"],
        pickupDate: "2026-06-02",
        pickupTimeFrom: "10:00",
        pickupTimeTo: "12:00",
        additionalInfo: "",
      }),
    ).rejects.toThrow("Use dhl-book-courier route");
    await expect(
      port.repairDhlCourierPickup({
        pickupId: "11111111-1111-4111-8111-111111111111",
        mode: "dry_run",
        sendEmails: false,
        expectedCourierOrderId: "courier-1",
        expectedShipmentCount: 1,
      }),
    ).rejects.toThrow("Use dhl-repair-courier-pickup route");
  });
});

function legacyBody(input: {
  providerDeleted?: boolean;
  providerError?: string | null;
  labelDeleted?: boolean;
  canProceed?: boolean;
} = {}) {
  return {
    dhl_deleted: input.providerDeleted ?? false,
    dhl_error: input.providerError ?? null,
    label_deleted: input.labelDeleted ?? false,
    can_proceed: input.canProceed ?? true,
  };
}

function portBody(input: {
  providerDeleted?: boolean;
  providerError?: string | null;
  labelDeleted?: boolean;
} = {}) {
  return {
    dhlDeleted: input.providerDeleted ?? false,
    dhlError: input.providerError ?? null,
    labelDeleted: input.labelDeleted ?? false,
    canProceed: true,
  };
}
