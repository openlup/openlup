import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  FulfillmentPreflightError,
  FulfillmentProviderError,
} from "../../../src/domains/fulfillment/ports.js";
import {
  createDhlCourierRepairPort,
  mapLegacyRepairDhlCourierPickupResponse,
  runDhlCourierRepair,
} from "./courierRepairAdapter.js";

describe("DHL courier repair adapter", () => {
  it("maps legacy repair responses into the BFF contract", () => {
    expect(
      mapLegacyRepairDhlCourierPickupResponse({
        mode: "dry_run",
        pickup_id: "7aa14057-cea4-48f7-b40c-e4c35e2c732b",
        pickup_status: "indeterminate",
        courier_order: "877230626WWW",
        recorded_shipments_count: 38,
        linked_shipments_count: 38,
        expected_shipments_count: 38,
        can_commit: false,
        committed: false,
        already_repaired: false,
        tester_statuses: [{
          tester_id: "tester-1",
          tracking_number: "30701335502",
          dhl_shipment_id: "30701335502",
          status: "packing",
          email_status: null,
          email_already_sent: false,
          will_request_email: false,
        }],
        email_dedup_preview: {
          send_emails: false,
          already_sent_count: 0,
          request_count: 0,
        },
      }),
    ).toEqual({
      mode: "dry_run",
      pickupId: "7aa14057-cea4-48f7-b40c-e4c35e2c732b",
      pickupStatus: "indeterminate",
      courierOrderId: "877230626WWW",
      recordedShipmentsCount: 38,
      linkedShipmentsCount: 38,
      expectedShipmentsCount: 38,
      canCommit: false,
      committed: false,
      alreadyRepaired: false,
      testerStatuses: [{
        testerId: "tester-1",
        trackingNumber: "30701335502",
        dhlShipmentId: "30701335502",
        status: "packing",
        emailStatus: null,
        emailAlreadySent: false,
        willRequestEmail: false,
      }],
      emailDedupPreview: {
        sendEmails: false,
        alreadySentCount: 0,
        requestCount: 0,
      },
    });
  });

  it("maps missing repair fields to legacy-safe defaults", () => {
    expect(mapLegacyRepairDhlCourierPickupResponse({})).toEqual({
      mode: "dry_run",
      pickupId: "",
      pickupStatus: "",
      courierOrderId: "",
      recordedShipmentsCount: 0,
      linkedShipmentsCount: 0,
      expectedShipmentsCount: 0,
      canCommit: false,
      committed: false,
      alreadyRepaired: false,
      testerStatuses: [],
      emailDedupPreview: {
        sendEmails: false,
        alreadySentCount: 0,
        requestCount: 0,
      },
    });
  });

  it("runs the local courier handler runner with the repair payload once", async () => {
    const runCourier = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        mode: "dry_run",
        pickup_id: "7aa14057-cea4-48f7-b40c-e4c35e2c732b",
        pickup_status: "indeterminate",
        courier_order: "877230626WWW",
        recorded_shipments_count: 38,
        linked_shipments_count: 38,
        expected_shipments_count: 38,
        can_commit: false,
        email_dedup_preview: { send_emails: false, already_sent_count: 2, request_count: 0 },
      },
    });
    const port = createDhlCourierRepairPort({
      accessToken: "admin-token",
      env: { SUPABASE_URL: "https://example.supabase.co" },
      runCourier,
    });

    await expect(
      port.repairDhlCourierPickup({
        pickupId: "7aa14057-cea4-48f7-b40c-e4c35e2c732b",
        mode: "dry_run",
        sendEmails: false,
        expectedCourierOrderId: "877230626WWW",
        expectedShipmentCount: 38,
      }),
    ).resolves.toMatchObject({
      mode: "dry_run",
      pickupId: "7aa14057-cea4-48f7-b40c-e4c35e2c732b",
      canCommit: false,
      emailDedupPreview: { sendEmails: false, alreadySentCount: 2, requestCount: 0 },
    });

    expect(runCourier).toHaveBeenCalledTimes(1);
    expect(runCourier).toHaveBeenCalledWith(
      {
        accessToken: "admin-token",
        body: {
          pickup_id: "7aa14057-cea4-48f7-b40c-e4c35e2c732b",
          mode: "dry_run",
          send_emails: false,
          expected_courier_order_id: "877230626WWW",
          expected_shipment_count: 38,
        },
      },
      { SUPABASE_URL: "https://example.supabase.co" },
    );
  });

  it("throws upstream runner errors", async () => {
    const port = createDhlCourierRepairPort({
      accessToken: "admin-token",
      runCourier: vi.fn().mockResolvedValue({ status: 502, body: { error: "handler down" } }),
    });

    await expect(
      port.repairDhlCourierPickup({
        pickupId: "7aa14057-cea4-48f7-b40c-e4c35e2c732b",
        mode: "dry_run",
        sendEmails: false,
        expectedCourierOrderId: "877230626WWW",
        expectedShipmentCount: 38,
      }),
    ).rejects.toThrow("handler down");
  });

  it("keeps default repair local even when retired DHL credentials are absent", async () => {
    const source = await readFile(new URL("./courierRepairAdapter.ts", import.meta.url), "utf8");

    expect(source).not.toContain("CARRIER_ENV_KEYS");
    expect(source).not.toContain("dhl_credentials_not_configured");
    expect(source).not.toContain("adminDhlSoap");
    expect(source).not.toContain("createCarrierPickupBookingAction");
    expect(source).not.toContain("runCarrierPickup(");
  });

  it("does not use retired DHL credentials or network egress before local-store configuration", async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockRejectedValue(new Error("network egress forbidden"));

    await expect(runDhlCourierRepair(
      {
        accessToken: "admin-token",
        body: {
          pickup_id: "7aa14057-cea4-48f7-b40c-e4c35e2c732b",
          mode: "dry_run",
          send_emails: false,
          expected_courier_order_id: "877230626WWW",
          expected_shipment_count: 38,
        },
      },
      {
        DHL_API_URL: "https://retired-dhl.invalid",
        DHL_API_USERNAME: "retired-user",
        DHL_API_PASSWORD: "retired-password",
      },
      fetchSpy,
    )).resolves.toEqual({ status: 500, body: { error: "supabase_service_role_not_configured" } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps legacy provider errors through the shared DHL provider sanitizer", async () => {
    const port = createDhlCourierRepairPort(
      {
        accessToken: "admin-token",
        runCourier: vi.fn().mockResolvedValue({
          status: 200,
          body: {
            error: { message: "raw DHL failure" },
            error_code: "DHL_PROVIDER",
            provider_error: {
              operator_message: "operator-safe failure",
              retryable: true,
              supportCode: "DHL-1",
            },
          },
        }),
      },
    );

    await expect(
      port.repairDhlCourierPickup({
        pickupId: "7aa14057-cea4-48f7-b40c-e4c35e2c732b",
        mode: "dry_run",
        sendEmails: false,
        expectedCourierOrderId: "877230626WWW",
        expectedShipmentCount: 38,
      }),
    ).rejects.toMatchObject({
      name: "FulfillmentProviderError",
      provider: "dhl",
      operatorMessage: "operator-safe failure",
      retryable: true,
      supportCode: "DHL-1",
    } satisfies Partial<FulfillmentProviderError>);
  });

  it.each([
    { mode: "commit" as const, sendEmails: false },
    { mode: "dry_run" as const, sendEmails: true },
  ])("rejects retired mutation %# before invoking the local runner", async (retired) => {
    const runCourier = vi.fn();
    const port = createDhlCourierRepairPort({
      accessToken: "admin-token",
      runCourier,
    });

    await expect(
      port.repairDhlCourierPickup({
        pickupId: "7aa14057-cea4-48f7-b40c-e4c35e2c732b",
        ...retired,
        expectedCourierOrderId: "877230626WWW",
        expectedShipmentCount: 38,
      }),
    ).rejects.toMatchObject({
      name: "FulfillmentPreflightError",
      details: { reason: "direct_dhl_repair_mutation_retired" },
    } satisfies Partial<FulfillmentPreflightError>);
    expect(runCourier).not.toHaveBeenCalled();
  });

  it("rejects unrelated DHL shipment port methods instead of calling another provider surface", async () => {
    const port = createDhlCourierRepairPort({ accessToken: "admin-token", runCourier: vi.fn() });

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
    await expect(port.clearDhlShipmentState({ testerId: "tester-1" })).rejects.toThrow(
      "Use dhl-clear-shipment-state route",
    );
  });
});
